"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/figma/react-router-compat";
import { api, apiUrl, extractUserFacingApiMessage, formatApiError, rawApi } from "@/lib/api";
import { formatDateFr } from "@/lib/dateFormat";
import { resolveProFeatureGate } from "@/lib/productCapabilities";
import { useSession } from "@/lib/useSession";
import {
  ActionMenu,
  ActionMenuButton,
  AppPageHeader,
  Card,
  PrimaryLinkButton,
  SecondaryButton,
  StatusPill,
} from "../../components/app/AppPageHeader";
import { EmptyCard, NoticeBanner } from "../../components/app/Feedback";
import { GuidanceTooltip } from "../../components/app/GuidanceTooltip";
import { ListPagination, paginateList } from "../../components/app/ListPagination";
import { SalesListBlock, SalesMetricCard, SalesPeriodControl } from "../../components/app/SalesModuleLayout";
import { WorkbenchPage } from "../../components/app/WorkbenchLayout";
import { UpgradeNoticeCard } from "../../components/app/UpgradeNoticeCard";
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  ArrowUpDown,
  Calendar,
  CheckSquare,
  Download,
  BarChart3,
  Settings,
  ShieldCheck,
  Trash2,
  Upload,
  Wallet,
} from "lucide-react";

type MovementKind = "incoming" | "outgoing";
type CashSortKey = "movement" | "date" | "relation" | "amount" | "source" | "status";
type CashSortDirection = "asc" | "desc";
type CashSortState = {
  key: CashSortKey;
  direction: CashSortDirection;
};

type BankMovement = {
  id: string;
  title: string;
  detail: string;
  amount: number;
  currency: string;
  date: string | null;
  relation: string;
  source: string;
  kind: MovementKind;
  needsReview: boolean;
  statusLabel: string;
  statusTone: "ok" | "warn" | "muted" | "info" | "danger";
  href: string;
  origin: "app" | "import";
  matchLabel?: string;
  matchTargetId?: string | null;
  bankTransactionId?: string;
  targetType?: string | null;
};

type ImportedBankRow = {
  id: string;
  date: string | null;
  label: string;
  amount: number;
  currency: string;
  status?: string;
  target_type?: string | null;
  target_id?: string | null;
  target_label?: string | null;
  note?: string | null;
};

type VatSummary = {
  period?: {
    start_date?: string | null;
    end_date?: string | null;
  };
  regime?: {
    label?: string | null;
    basis?: string | null;
  };
  collected?: {
    vat?: number | null;
    document_count?: number | null;
  };
  deductible?: {
    vat?: number | null;
    document_count?: number | null;
    excluded_count?: number | null;
  };
  net_vat?: number | null;
  latest_validation?: {
    id?: string | null;
    status?: string | null;
    start_date?: string | null;
    end_date?: string | null;
    validated_at?: string | null;
    validated_by_email?: string | null;
    cabinet_comment?: string | null;
    net_vat?: number | null;
    anomaly_count?: number | null;
    anomaly_item_count?: number | null;
  } | null;
  anomalies?: Array<{
    code?: string;
    label?: string;
    count?: number;
    severity?: "info" | "warning" | "danger";
    action?: {
      label?: string | null;
      href?: string | null;
      description?: string | null;
    } | null;
  }>;
  anomaly_items?: Array<{
    code?: string;
    severity?: "info" | "warning" | "danger";
    document_id?: string | null;
    direction?: string | null;
    kind?: string | null;
    number?: string | null;
    party?: string | null;
    field?: string | null;
    current_value?: string | number | null;
    message?: string | null;
    correction_href?: string | null;
    correction_endpoint?: string | null;
    action_label?: string | null;
  }>;
  documents?: {
    total_count?: number | null;
    included_count?: number | null;
    excluded_count?: number | null;
    truncated?: boolean | null;
    rows?: Array<{
      id?: string;
      direction?: string;
      kind?: string;
      included?: boolean;
      reason?: string | null;
      date?: string | null;
      number?: string | null;
      party?: string | null;
      vat_effect?: number | null;
      href?: string | null;
      action?: {
        label?: string | null;
        href?: string | null;
        description?: string | null;
      } | null;
    }>;
  };
  notice?: string | null;
};

const DEFAULT_CASH_PERIOD = "30";
const CASH_PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
const CASH_PAGE_SIZE_STORAGE_KEY = "pixfacture.cash.pageSize.v1";
const BANK_IMPORT_ROW_LIMIT = 500;
const BANK_IMPORT_FILE_MAX_BYTES = 1_000_000;

function readStoredCashPageSize() {
  if (typeof window === "undefined") return CASH_PAGE_SIZE_OPTIONS[0];
  const stored = Number(window.localStorage.getItem(CASH_PAGE_SIZE_STORAGE_KEY));
  return CASH_PAGE_SIZE_OPTIONS.some((option) => option === stored) ? stored : CASH_PAGE_SIZE_OPTIONS[0];
}

const cashPeriodOptions = [
  { value: "30", label: "30 derniers jours" },
  { value: "today", label: "Aujourd'hui" },
  { value: "7", label: "7 derniers jours" },
  { value: "month", label: "Mois en cours" },
  { value: "90", label: "90 derniers jours" },
  { value: "all", label: "Tout l'historique" },
];

const cashTableColumns: Array<{ key: CashSortKey; label: string }> = [
  { key: "date", label: "Date" },
  { key: "relation", label: "Relation" },
  { key: "amount", label: "Montant" },
  { key: "source", label: "Source" },
  { key: "status", label: "Statut" },
];

const money = (value: any, currency = "EUR") =>
  `${Number(value || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency === "EUR" ? "€" : currency}`;

const signedMoney = (value: number, currency = "EUR") => {
  const sign = value >= 0 ? "+ " : "- ";
  return `${sign}${money(Math.abs(value), currency)}`;
};

function methodLabel(method: string | null | undefined) {
  const normalized = (method || "").trim().toLowerCase();
  if (!normalized) return "Saisie manuelle";
  if (["card", "cb", "stripe"].includes(normalized)) return "Carte bancaire";
  if (["virement", "wire", "transfer", "sepa"].includes(normalized)) return "Virement";
  if (["check", "cheque"].includes(normalized)) return "Chèque";
  return method || "Saisie manuelle";
}

function purchaseStatus(doc: any): Pick<BankMovement, "needsReview" | "statusLabel" | "statusTone"> {
  const state = String(doc.workflow_state || "").toLowerCase();
  if (state === "booked") {
    return { needsReview: false, statusLabel: "Traité", statusTone: "ok" };
  }
  if (state === "ready_to_pay") {
    return { needsReview: true, statusLabel: "À payer", statusTone: "warn" };
  }
  if (state === "approved") {
    return { needsReview: true, statusLabel: "Validé", statusTone: "info" };
  }
  if (state === "awaiting_supplier") {
    return { needsReview: true, statusLabel: "À compléter", statusTone: "danger" };
  }
  return { needsReview: true, statusLabel: doc.workflow_label || "À traiter", statusTone: "muted" };
}

function buildBankMovements(payload: any): BankMovement[] {
  const payments = Array.isArray(payload?.recent_payments) ? payload.recent_payments : [];
  const suppliers = Array.isArray(payload?.supplier_documents) ? payload.supplier_documents : [];

  const incoming = payments.map((payment: any): BankMovement => {
    const hasInvoice = Boolean(payment.invoice_id);
    const amount = Number(payment.amount || 0);
    const isRefund = amount < 0 || String(payment.settlement_mode || "").toLowerCase() === "refund";
    return {
      id: `payment-${payment.payment_id || payment.invoice_id || payment.date}`,
      title: isRefund ? "Remboursement avoir" : "Encaissement",
      detail: payment.invoice_number
        ? `${isRefund ? "Avoir" : "Facture"} ${payment.invoice_number}`
        : methodLabel(payment.method),
      amount,
      currency: payment.currency || "EUR",
      date: payment.date || null,
      relation: payment.customer_name || "Client",
      source: isRefund ? "Remboursement avoir" : "Paiement facture",
      kind: amount >= 0 ? "incoming" : "outgoing",
      needsReview: !hasInvoice,
      statusLabel: hasInvoice ? "Rapproché" : "À vérifier",
      statusTone: hasInvoice ? "ok" : "warn",
      href: payment.invoice_id ? `/app/invoices/${payment.invoice_id}` : "/app/cash",
      origin: "app",
      matchTargetId: payment.payment_id || null,
      targetType: "payment",
    };
  });

  const outgoing = suppliers.map((doc: any): BankMovement => {
    const status = purchaseStatus(doc);
    const cashDate = doc.planned_payment_date || doc.received_at || null;
    const plannedLabel = doc.planned_payment_date ? ` · prévu le ${formatDateFr(doc.planned_payment_date)}` : "";
    return {
      id: `supplier-${doc.invoice_id}`,
      title: "Dépense fournisseur",
      detail: `${doc.invoice_number ? `Achat ${doc.invoice_number}` : "Achat fournisseur"}${plannedLabel}`,
      amount: -Number(doc.amount || 0),
      currency: doc.currency || "EUR",
      date: cashDate,
      relation: doc.supplier_name || "Fournisseur",
      source: "Achat",
      kind: "outgoing",
      href: doc.href || `/app/purchases/${doc.invoice_id}`,
      origin: "app",
      ...status,
    };
  });

  return [...incoming, ...outgoing].sort((a, b) => {
    const left = a.date ? new Date(a.date).getTime() : 0;
    const right = b.date ? new Date(b.date).getTime() : 0;
    return right - left;
  });
}

function movementDateValue(value: string | null) {
  if (!value) return "";
  return value.slice(0, 10);
}

function normalizeCashSortText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function cashSortValue(movement: BankMovement, key: CashSortKey) {
  if (key === "date") {
    if (!movement.date) return 0;
    const time = new Date(movement.date).getTime();
    return Number.isFinite(time) ? time : 0;
  }
  if (key === "amount") return movement.amount;
  if (key === "movement") return normalizeCashSortText(`${movement.title} ${movement.detail}`);
  if (key === "relation") return normalizeCashSortText(movement.relation);
  if (key === "source") return normalizeCashSortText(movement.source);
  return normalizeCashSortText(movement.statusLabel);
}

function compareCashValues(left: string | number, right: string | number) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), "fr", { numeric: true, sensitivity: "base" });
}

function compareCashMovements(left: BankMovement, right: BankMovement, sortState: CashSortState) {
  const result = compareCashValues(cashSortValue(left, sortState.key), cashSortValue(right, sortState.key));
  if (result !== 0) return sortState.direction === "asc" ? result : -result;
  const fallback = compareCashValues(cashSortValue(left, "date"), cashSortValue(right, "date"));
  if (fallback !== 0) return -fallback;
  return left.id.localeCompare(right.id, "fr", { numeric: true, sensitivity: "base" });
}

function CashTableHeader({
  sortKey,
  sortState,
  onSort,
  children,
}: {
  sortKey: CashSortKey;
  sortState: CashSortState;
  onSort: (key: CashSortKey) => void;
  children: string;
}) {
  const active = sortState.key === sortKey;
  const Icon = active ? (sortState.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;

  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-label={`Trier par ${children}`}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-[#fff7ed] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#fdba74] ${
        active ? "pf-sort-header-active" : ""
      }`}
      style={{
        color: active ? "#ea580c" : "#94a3b8",
        fontSize: "var(--pf-app-table-header)",
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        lineHeight: 1.15,
      }}
    >
      <span>{children}</span>
      <Icon className="h-3 w-3" aria-hidden="true" style={{ color: active ? "#f97316" : "#cbd5e1" }} />
    </button>
  );
}

function numberOrNull(value: string) {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function parseFrenchNumber(value: any) {
  const raw = String(value ?? "")
    .replace(/\u00a0/g, "")
    .replace(/\s/g, "")
    .replace(/[€"]/g, "")
    .replace(",", ".")
    .trim();
  const cleaned = raw.replace(/[^0-9.+-]/g, "");
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : 0;
}

function splitCsvLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (char === ";" || char === "," || char === "\t")) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function normalizeHeader(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function findColumn(headers: string[], candidates: string[]) {
  return headers.findIndex((header) => candidates.some((candidate) => header.includes(candidate)));
}

function parseImportedCsv(content: string): ImportedBankRow[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const firstLine = splitCsvLine(lines[0]);
  const headers = firstLine.map(normalizeHeader);
  const hasHeader = headers.some((header) =>
    ["date", "libelle", "intitule", "montant", "debit", "credit"].includes(header),
  );
  const dateIndex = hasHeader ? findColumn(headers, ["date", "operation"]) : 0;
  const labelIndex = hasHeader ? findColumn(headers, ["libelle", "intitule", "description", "operation"]) : 1;
  const amountIndex = hasHeader ? findColumn(headers, ["montant", "amount"]) : 2;
  const debitIndex = hasHeader ? findColumn(headers, ["debit", "sortie"]) : -1;
  const creditIndex = hasHeader ? findColumn(headers, ["credit", "entree"]) : -1;
  const rows = hasHeader ? lines.slice(1) : lines;

  return rows
    .map((line, index): ImportedBankRow | null => {
      const cells = splitCsvLine(line);
      const rawDate = cells[dateIndex] || "";
      const dateMatch = rawDate.match(/(\d{4}-\d{2}-\d{2})|(\d{2}\/\d{2}\/\d{4})/);
      const date = dateMatch?.[1] ? dateMatch[1] : dateMatch?.[2] ? dateMatch[2].split("/").reverse().join("-") : null;
      const label = cells[labelIndex] || "Ligne importée";
      const amount =
        amountIndex >= 0 && cells[amountIndex]
          ? parseFrenchNumber(cells[amountIndex])
          : parseFrenchNumber(cells[creditIndex]) - parseFrenchNumber(cells[debitIndex]);
      if (!Number.isFinite(amount) || amount === 0) return null;
      return {
        id: `import-${Date.now()}-${index}`,
        date,
        label,
        amount,
        currency: "EUR",
      };
    })
    .filter(Boolean) as ImportedBankRow[];
}

function normalizeMatchText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function daysBetween(left: string | null, right: string | null) {
  if (!left || !right) return 99;
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 99;
  return Math.abs(leftTime - rightTime) / 86400000;
}

function suggestedMatch(row: ImportedBankRow, candidates: BankMovement[]) {
  const label = normalizeMatchText(row.label);
  let best: { movement: BankMovement; score: number } | null = null;
  for (const movement of candidates) {
    let score = 0;
    if (Math.abs(Math.abs(movement.amount) - Math.abs(row.amount)) < 0.01) score += 4;
    if ((movement.amount >= 0 && row.amount >= 0) || (movement.amount < 0 && row.amount < 0)) score += 2;
    if (daysBetween(row.date, movement.date) <= 5) score += 2;
    const relation = normalizeMatchText(movement.relation);
    const detail = normalizeMatchText(movement.detail);
    if ((relation.length > 3 && label.includes(relation)) || (detail.length > 3 && label.includes(detail))) score += 2;
    if (!best || score > best.score) best = { movement, score };
  }
  return best && best.score >= 6 ? best.movement : null;
}

function buildImportedMovements(rows: ImportedBankRow[], candidates: BankMovement[]): BankMovement[] {
  return rows.map((row): BankMovement => {
    const match = suggestedMatch(row, candidates);
    const kind: MovementKind = row.amount >= 0 ? "incoming" : "outgoing";
    const matched = String(row.status || "").toLowerCase() === "matched";
    const manualReview = String(row.target_type || "").toLowerCase() === "manual" && !matched;
    const matchTargetId = row.target_id || match?.matchTargetId || null;
    return {
      id: row.id,
      title: row.amount >= 0 ? "Entrée importée" : "Sortie importée",
      detail: manualReview
        ? `À valider comptablement : ${row.label}`
        : matched
          ? `Rapproché : ${row.target_label || row.label}`
          : match
            ? `Suggestion : ${match.detail}`
            : row.label,
      amount: row.amount,
      currency: row.currency || "EUR",
      date: row.date,
      relation: manualReview ? "Classement manuel" : row.target_label || match?.relation || "Relevé importé",
      source: "Import CSV",
      kind,
      needsReview: !matched,
      statusLabel: matched ? "Rapproché" : manualReview ? "À valider compta" : match ? "Suggestion" : "À rapprocher",
      statusTone: matched ? "ok" : manualReview ? "warn" : match ? "info" : "warn",
      href:
        matched && row.target_type === "purchase" && row.target_id
          ? `/app/purchases/${row.target_id}`
          : match?.href || (kind === "incoming" ? "/app/cash" : "/app/purchases"),
      origin: "import",
      matchLabel: manualReview ? row.target_label || "Classement manuel" : row.target_label || match?.detail,
      matchTargetId,
      bankTransactionId: row.id,
      targetType: row.target_type || null,
    };
  });
}

function isInPeriod(date: string | null, period: string) {
  if (period === "all") return true;
  if (!date) return false;
  const value = new Date(date).getTime();
  if (!Number.isFinite(value)) return false;
  const now = new Date();
  if (period === "today") {
    return new Date(date).toDateString() === now.toDateString();
  }
  if (period === "month") {
    return new Date(date).getMonth() === now.getMonth() && new Date(date).getFullYear() === now.getFullYear();
  }
  const days = period === "7" ? 7 : period === "30" ? 30 : period === "90" ? 90 : 0;
  if (!days) return true;
  return now.getTime() - value <= days * 86400000;
}

function csvEscape(value: any) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function downloadMovementsCsv(filename: string, rows: BankMovement[]) {
  if (typeof window === "undefined") return;
  const csvRows = [
    ["Date", "Mouvement", "Détail", "Relation", "Source", "Origine", "Montant", "Statut", "Suggestion"],
    ...rows.map((row) => [
      movementDateValue(row.date),
      row.title,
      row.detail,
      row.relation,
      row.source,
      row.origin === "import" ? "Import" : "Application",
      row.amount.toFixed(2),
      row.statusLabel,
      row.matchLabel || "",
    ]),
  ];
  const blob = new Blob([csvRows.map((row) => row.map(csvEscape).join(";")).join("\n")], {
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
}

export function CashPage() {
  const { capabilities, loading: sessionLoading } = useSession();
  const paymentsGate = resolveProFeatureGate(capabilities, "payments");
  const paymentsEnabled = paymentsGate.enabled;
  const importRef = useRef<HTMLInputElement | null>(null);
  const [importRows, setImportRows] = useState<ImportedBankRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [payload, setPayload] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [viewFilter, setViewFilter] = useState("all");
  const [periodFilter, setPeriodFilter] = useState(DEFAULT_CASH_PERIOD);
  const [vatSummary, setVatSummary] = useState<VatSummary | null>(null);
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [matchingMovement, setMatchingMovement] = useState<BankMovement | null>(null);
  const [matchTargetId, setMatchTargetId] = useState("");
  const [matchNote, setMatchNote] = useState("");
  const [matchBusy, setMatchBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => readStoredCashPageSize());
  const [selectedMovementIds, setSelectedMovementIds] = useState<string[]>([]);
  const [cashExportToolsOpen, setCashExportToolsOpen] = useState(false);
  const [sortState, setSortState] = useState<CashSortState>({ key: "date", direction: "desc" });
  const toggleSort = useCallback((key: CashSortKey) => {
    setSortState((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );
    setPage(1);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nextView = params.get("view");
    if (nextView && ["all", "incoming", "outgoing", "review", "imported"].includes(nextView)) {
      setViewFilter(nextView);
    }
    const nextPeriod = params.get("period");
    if (nextPeriod && ["all", "today", "7", "month", "30", "90"].includes(nextPeriod)) {
      setPeriodFilter(nextPeriod);
    }
  }, []);

  const load = useCallback(async () => {
    if (sessionLoading || !paymentsEnabled) return;
    setLoading(true);
    setError(null);
    try {
      const cashParams = new URLSearchParams();
      cashParams.set("period", periodFilter);
      const [res, vatRes] = await Promise.all([
        rawApi(`/api/collections/cash-dashboard?${cashParams.toString()}`),
        rawApi("/api/cockpit/vat?include_documents=true&document_limit=12").catch(() => null),
      ]);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(extractUserFacingApiMessage(data, res.status, "Impossible de charger les paiements."));
      }
      const data = await res.json().catch(() => null);
      setPayload(data || null);
      setImportRows(Array.isArray(data?.manual_bank_transactions) ? data.manual_bank_transactions : []);
      if (vatRes?.ok) {
        setVatSummary((await vatRes.json().catch(() => null)) || null);
      } else {
        setVatSummary(null);
      }
    } catch (err) {
      setPayload(null);
      setImportRows([]);
      setVatSummary(null);
      setError(formatApiError(err, "Impossible de charger la vue paiements."));
    } finally {
      setLoading(false);
    }
  }, [paymentsEnabled, periodFilter, sessionLoading]);

  useEffect(() => {
    if (sessionLoading || !paymentsEnabled) return;
    void load();
  }, [load, paymentsEnabled, sessionLoading]);

  const appMovements = useMemo(() => buildBankMovements(payload), [payload]);
  const importedMovements = useMemo(() => buildImportedMovements(importRows, appMovements), [appMovements, importRows]);
  const movements = useMemo(
    () =>
      [...appMovements, ...importedMovements].sort((a, b) => {
        const left = a.date ? new Date(a.date).getTime() : 0;
        const right = b.date ? new Date(b.date).getTime() : 0;
        return right - left;
      }),
    [appMovements, importedMovements],
  );
  const purchaseCandidates = useMemo(() => {
    const documents = Array.isArray(payload?.supplier_documents) ? payload.supplier_documents : [];
    return documents
      .map((doc: any) => ({
        id: String(doc.invoice_id || ""),
        label: `${doc.supplier_name || "Fournisseur"} · ${doc.invoice_number || "Achat"} · ${money(doc.amount, doc.currency || "EUR")}`,
        stateLabel: doc.workflow_label || "À traiter",
      }))
      .filter((candidate: { id: string }) => candidate.id);
  }, [payload]);
  const paymentCandidates = useMemo(
    () =>
      appMovements
        .filter((movement) => movement.kind === "incoming" && movement.matchTargetId)
        .map((movement) => ({
          id: String(movement.matchTargetId),
          label: `${movement.relation} · ${movement.detail} · ${money(movement.amount, movement.currency)}`,
          stateLabel: movement.statusLabel,
        })),
    [appMovements],
  );
  const periodFilteredMovements = useMemo(() => {
    const query = search.trim().toLowerCase();
    const min = numberOrNull(amountMin);
    const max = numberOrNull(amountMax);
    return movements.filter((movement) => {
      if (!isInPeriod(movement.date, periodFilter)) return false;
      const absAmount = Math.abs(movement.amount);
      if (min !== null && absAmount < min) return false;
      if (max !== null && absAmount > max) return false;
      if (!query) return true;
      return [movement.title, movement.detail, movement.relation, movement.source, movement.statusLabel]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [amountMax, amountMin, movements, periodFilter, search]);
  const filteredMovements = useMemo(
    () =>
      periodFilteredMovements.filter((movement) => {
        if (viewFilter === "incoming" && movement.kind !== "incoming") return false;
        if (viewFilter === "outgoing" && movement.kind !== "outgoing") return false;
        if (viewFilter === "review" && !movement.needsReview) return false;
        if (viewFilter === "imported" && movement.origin !== "import") return false;
        return true;
      }),
    [periodFilteredMovements, viewFilter],
  );

  const sortedMovements = useMemo(
    () => [...filteredMovements].sort((left, right) => compareCashMovements(left, right, sortState)),
    [filteredMovements, sortState],
  );
  const pageRows = useMemo(() => paginateList(sortedMovements, page, pageSize), [page, pageSize, sortedMovements]);
  const pageMovementIds = useMemo(() => pageRows.map((movement) => String(movement.id)).filter(Boolean), [pageRows]);
  const selectedMovementCount = pageMovementIds.filter((movementId) => selectedMovementIds.includes(movementId)).length;
  const selectedMovements = useMemo(
    () => filteredMovements.filter((movement) => selectedMovementIds.includes(String(movement.id))),
    [filteredMovements, selectedMovementIds],
  );
  const allPageMovementsSelected = pageMovementIds.length > 0 && selectedMovementCount === pageMovementIds.length;
  const toggleMovementSelection = (movementId: string) => {
    setSelectedMovementIds((current) =>
      current.includes(movementId) ? current.filter((id) => id !== movementId) : [...current, movementId],
    );
  };
  const toggleMovementPageSelection = () => {
    setSelectedMovementIds((current) => {
      if (allPageMovementsSelected) return current.filter((id) => !pageMovementIds.includes(id));
      const next = new Set(current);
      pageMovementIds.forEach((id) => next.add(id));
      return Array.from(next);
    });
  };

  useEffect(() => {
    setPage(1);
  }, [amountMax, amountMin, periodFilter, search, viewFilter]);
  useEffect(() => {
    const visibleIds = new Set(filteredMovements.map((movement) => String(movement.id)));
    setSelectedMovementIds((current) => current.filter((id) => visibleIds.has(id)));
  }, [filteredMovements]);

  const incomingCount = periodFilteredMovements.filter((movement) => movement.kind === "incoming").length;
  const outgoingCount = periodFilteredMovements.filter((movement) => movement.kind === "outgoing").length;
  const reviewCount = periodFilteredMovements.filter((movement) => movement.needsReview).length;
  const importedCount = periodFilteredMovements.filter((movement) => movement.origin === "import").length;
  const matchedImportCount = importedMovements.filter((movement) => !movement.needsReview).length;
  const suggestedImportCount = importedMovements.filter(
    (movement) => movement.needsReview && movement.matchLabel,
  ).length;
  const unmatchedImportCount = importedMovements.filter(
    (movement) => movement.needsReview && !movement.matchLabel,
  ).length;
  const netPeriod = Number(payload?.manual_net_period ?? payload?.manual_net_last_30_days ?? 0);
  const collectedPeriod = Number(payload?.collected_period ?? payload?.collected_last_30_days ?? 0);
  const supplierPaidPeriod = Number(payload?.supplier_paid_period ?? payload?.supplier_booked_last_30_days ?? 0);
  const hasActiveFilters =
    viewFilter !== "all" ||
    periodFilter !== DEFAULT_CASH_PERIOD ||
    search.trim().length > 0 ||
    amountMin.trim().length > 0 ||
    amountMax.trim().length > 0;
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CASH_PAGE_SIZE_STORAGE_KEY, String(pageSize));
  }, [pageSize]);
  const vatExcludedCount = Number(vatSummary?.documents?.excluded_count || 0);
  const vatPurchaseCorrections = (vatSummary?.anomaly_items || []).filter(
    (item) => item.direction === "purchase" || String(item.correction_href || "").startsWith("/app/purchases"),
  );
  const vatCollectedAmount = Number(vatSummary?.collected?.vat || 0);
  const vatDeductibleAmount = Number(vatSummary?.deductible?.vat || 0);
  const vatNetAmount = Number(vatSummary?.net_vat || 0);
  const vatIsCredit = vatNetAmount < 0;
  const vatPendingImpactCount = vatPurchaseCorrections.length + vatExcludedCount;

  const exportVatCsv = () => {
    const params = new URLSearchParams();
    if (vatSummary?.period?.start_date) params.set("start_date", vatSummary.period.start_date);
    if (vatSummary?.period?.end_date) params.set("end_date", vatSummary.period.end_date);
    const suffix = params.toString();
    window.location.assign(apiUrl(`/api/cockpit/vat/export.csv${suffix ? `?${suffix}` : ""}`));
  };

  const resetFilters = () => {
    setSearch("");
    setViewFilter("all");
    setPeriodFilter(DEFAULT_CASH_PERIOD);
    setAmountMin("");
    setAmountMax("");
    setPage(1);
  };

  const importBankFile = async (file: File) => {
    try {
      if (file.size > BANK_IMPORT_FILE_MAX_BYTES) {
        setNotice("Fichier trop volumineux : importez un relevé CSV de moins de 1 Mo.");
        return;
      }
      const content = await file.text();
      const rows = parseImportedCsv(content);
      if (!rows.length) {
        setNotice(
          "Aucune ligne exploitable trouvée dans le relevé. Colonnes conseillées : date, libellé, montant ou débit/crédit.",
        );
        return;
      }
      if (rows.length > BANK_IMPORT_ROW_LIMIT) {
        setNotice(
          `Import trop volumineux : limitez le relevé à ${BANK_IMPORT_ROW_LIMIT} mouvements pour éviter un rapprochement incomplet.`,
        );
        return;
      }
      const imported = await api("/api/collections/bank-transactions/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      setImportRows(Array.isArray(imported?.items) ? imported.items : []);
      setViewFilter("imported");
      await load();
      const count = Number(imported?.imported_count || rows.length);
      setNotice(
        `${count} mouvement${count > 1 ? "s" : ""} importé${count > 1 ? "s" : ""}. Vous pouvez maintenant justifier les lignes et solder les achats correspondants.`,
      );
    } catch (err) {
      setNotice(formatApiError(err, "Impossible de lire ce fichier CSV."));
    }
  };

  const clearImportedRows = async () => {
    try {
      await api("/api/collections/bank-transactions", { method: "DELETE" });
      setImportRows([]);
      if (viewFilter === "imported") setViewFilter("all");
      setNotice("Les mouvements importés ont été retirés du rapprochement.");
      await load();
    } catch (err) {
      setNotice(formatApiError(err, "Impossible d'effacer les mouvements importés."));
    }
  };

  const openJustification = (movement: BankMovement) => {
    setMatchingMovement(movement);
    setMatchTargetId(
      movement.matchTargetId ||
        (movement.kind === "incoming" ? paymentCandidates[0]?.id : purchaseCandidates[0]?.id) ||
        "",
    );
    setMatchNote("");
  };

  const justifyImportedMovement = async (targetType: "purchase" | "payment" | "manual") => {
    if (!matchingMovement?.bankTransactionId) return;
    if ((targetType === "purchase" || targetType === "payment") && !matchTargetId) {
      setNotice(
        targetType === "purchase"
          ? "Sélectionnez un achat à rapprocher, ou classez le mouvement hors achat."
          : "Sélectionnez un paiement client à rapprocher, ou classez le mouvement manuellement.",
      );
      return;
    }
    setMatchBusy(true);
    try {
      await api(`/api/collections/bank-transactions/${matchingMovement.bankTransactionId}/justify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_type: targetType,
          target_id: targetType === "purchase" || targetType === "payment" ? matchTargetId : null,
          note: matchNote,
        }),
      });
      setMatchingMovement(null);
      setMatchTargetId("");
      setMatchNote("");
      await load();
      setViewFilter("imported");
      setNotice(
        targetType === "purchase"
          ? "Mouvement rapproché. L'achat est passé en traité."
          : targetType === "payment"
            ? "Entrée bancaire rapprochée avec le paiement client."
            : "Mouvement classé hors achat. Il reste visible tant qu'une validation comptable n'est pas faite.",
      );
    } catch (err) {
      setNotice(formatApiError(err, "Impossible de justifier ce mouvement."));
    } finally {
      setMatchBusy(false);
    }
  };

  const filterOptions = [
    { value: "all", label: "Tous", count: periodFilteredMovements.length, accent: "module" as const },
    { value: "incoming", label: "Encaissements", count: incomingCount, accent: "module" as const },
    { value: "outgoing", label: "Sorties", count: outgoingCount, accent: "module" as const },
    { value: "review", label: "À vérifier", count: reviewCount, accent: "module" as const },
    { value: "imported", label: "Imports CSV", count: importedCount, accent: "module" as const },
  ];

  if (!sessionLoading && !paymentsEnabled) {
    return (
      <div>
        <AppPageHeader
          title="Encaissements & paiements"
          breadcrumb="Encaissements & paiements"
          description="Suivi des règlements, paiements fournisseurs, imports et rapprochements disponible avec Pro."
        />
        <WorkbenchPage>
          <UpgradeNoticeCard
            title={
              paymentsGate.reactivationRequired ? paymentsGate.statusLabel : "Paiements disponibles avec le plan Pro"
            }
            description={
              paymentsGate.reactivationDescription ||
              "Starter reste centré sur les clients, devis et factures PDF. Passez à Pro pour enregistrer les règlements, suivre les achats et rapprocher les mouvements."
            }
            ctaLabel={paymentsGate.ctaLabel}
            ctaHref={paymentsGate.ctaHref}
            note={paymentsGate.reactivationNote || undefined}
          />
        </WorkbenchPage>
      </div>
    );
  }

  return (
    <div>
      <AppPageHeader
        title="Encaissements & paiements"
        breadcrumb="Encaissements & paiements"
        description="Suivi des règlements clients, paiements fournisseurs, imports CSV et rapprochements."
      />

      <WorkbenchPage>
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
        {notice ? (
          <NoticeBanner tone="info" onDismiss={() => setNotice(null)} autoDismissMs={6000}>
            {notice}
          </NoticeBanner>
        ) : null}

        <input
          ref={importRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(event) => {
            if (event.target.files?.[0]) void importBankFile(event.target.files[0]);
            event.target.value = "";
          }}
        />

        {loading ? (
          <>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <Card key={index} className="min-h-[132px]">
                  <div className="animate-pulse space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="h-2.5 w-24 rounded-full bg-[#e2e8f0]" />
                      <div className="h-8 w-8 rounded-xl bg-[#eef2ff]" />
                    </div>
                    <div className="h-8 w-28 rounded-xl bg-[#e5e7eb]" />
                    <div className="h-2.5 w-32 rounded-full bg-[#f1f5f9]" />
                  </div>
                </Card>
              ))}
            </div>
            <Card padding={false}>
              <div className="animate-pulse space-y-4 p-5">
                <div className="h-9 max-w-xl rounded-xl bg-[#f1f5f9]" />
                <div className="h-72 rounded-2xl bg-[#f8fafc]" />
              </div>
            </Card>
          </>
        ) : !payload ? (
          <EmptyCard
            compact
            className="border-dashed border-[#dbe5ef] shadow-none"
            title="Aucun mouvement"
            description="Les mouvements apparaîtront dès qu'un paiement ou un achat fournisseur sera enregistré."
            action={<PrimaryLinkButton to="/app/invoices">Voir les factures</PrimaryLinkButton>}
          />
        ) : (
          <>
            <div className={`grid gap-3 lg:gap-4 md:grid-cols-2 xl:grid-cols-4 ${vatSummary ? "2xl:grid-cols-7" : ""}`}>
              <SalesMetricCard
                tone="cash"
                density="client"
                label="Solde net"
                value={signedMoney(netPeriod)}
                detail="Entrées moins sorties"
                icon={<Wallet className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="cash"
                density="client"
                accent="success"
                label="Encaissements reçus"
                value={money(collectedPeriod)}
                detail="Paiements reçus"
                icon={<ArrowDownLeft className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="cash"
                density="client"
                accent="warning"
                label="Sorties payées"
                value={money(supplierPaidPeriod)}
                detail="Achats et remboursements réglés"
                icon={<ArrowUpRight className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="cash"
                density="client"
                accent={reviewCount > 0 ? "danger" : "success"}
                label="À vérifier"
                value={reviewCount}
                detail="Mouvements incomplets ou à régler"
                icon={<ShieldCheck className="h-4 w-4" />}
              />
              {vatSummary ? (
                <>
                  <SalesMetricCard
                    tone="cash"
                    density="client"
                    accent="info"
                    label="TVA collectée"
                    value={money(vatCollectedAmount)}
                    detail={
                      <>
                        {vatSummary.regime?.basis || "Sur ventes encaissées"} ·{" "}
                        {vatSummary.collected?.document_count || 0} document(s)
                      </>
                    }
                    icon={<BarChart3 className="h-4 w-4" />}
                  />
                  <SalesMetricCard
                    tone="cash"
                    density="client"
                    accent="purple"
                    label="TVA déductible"
                    value={money(vatDeductibleAmount)}
                    detail={
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <span>{vatSummary.deductible?.document_count || 0} achat(s) qualifié(s)</span>
                        {vatExcludedCount > 0 ? (
                          <span className="rounded-full border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[10px] font-semibold text-orange-600">
                            +{vatExcludedCount} en attente
                          </span>
                        ) : null}
                      </span>
                    }
                    icon={<BarChart3 className="h-4 w-4" />}
                  />
                  <SalesMetricCard
                    tone="cash"
                    density="client"
                    accent={vatIsCredit ? "success" : "danger"}
                    label="Solde TVA"
                    value={`${vatIsCredit ? "+ " : ""}${money(Math.abs(vatNetAmount))}`}
                    detail={
                      vatPendingImpactCount > 0
                        ? `${vatPendingImpactCount} achat(s) à vérifier`
                        : vatIsCredit
                          ? "Crédit de TVA"
                          : "TVA à reverser"
                    }
                    icon={<ShieldCheck className="h-4 w-4" />}
                  />
                </>
              ) : null}
            </div>

            {importRows.length > 0 ? (
              <Card padding={false}>
                <div className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <div className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 800 }}>
                      Rapprochement du relevé importé
                    </div>
                    <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.5 }}>
                      Les lignes importées sont conservées dans le rapprochement. Justifie une sortie avec un achat pour
                      le passer en traité.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill
                      status="ok"
                      label={`${matchedImportCount} rapproché${matchedImportCount > 1 ? "s" : ""}`}
                    />
                    <StatusPill
                      status="info"
                      label={`${suggestedImportCount} suggestion${suggestedImportCount > 1 ? "s" : ""}`}
                    />
                    <StatusPill
                      status={unmatchedImportCount > 0 ? "warn" : "ok"}
                      label={`${unmatchedImportCount} à rapprocher`}
                    />
                    <SecondaryButton onClick={() => void clearImportedRows()}>
                      <Trash2 className="h-3.5 w-3.5" /> Effacer l'import
                    </SecondaryButton>
                  </div>
                </div>
              </Card>
            ) : null}

            <SalesListBlock
              tone="payments"
              density="client"
              filters={filterOptions}
              filterValue={viewFilter}
              onFilterChange={(value) => setViewFilter(value)}
              searchValue={search}
              onSearchChange={(value) => setSearch(value)}
              searchPlaceholder="Client, fournisseur, statut..."
              searchWidth="20rem"
              leftExtras={
                selectedMovements.length > 0 ? (
                  <ActionMenu label="Actions" badge={selectedMovements.length} triggerVariant="orange">
                    <ActionMenuButton
                      icon={Download}
                      onClick={() => downloadMovementsCsv("tresorerie_selection.csv", selectedMovements)}
                      aria-label={`Exporter la sélection de ${selectedMovements.length} mouvement(s)`}
                    >
                      Exporter la sélection
                    </ActionMenuButton>
                    <ActionMenuButton icon={CheckSquare} onClick={() => setSelectedMovementIds([])}>
                      Désélectionner
                    </ActionMenuButton>
                  </ActionMenu>
                ) : null
              }
              rightExtras={
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <SalesPeriodControl
                    tone="payments"
                    value={periodFilter}
                    onChange={(nextValue) => setPeriodFilter(nextValue)}
                    options={cashPeriodOptions}
                    ariaLabel="Période des mouvements"
                  />
                  <ActionMenu
                    label="Importer / exporter"
                    iconOnly
                    triggerIcon={Settings}
                    triggerVariant="orange"
                    className="pf-toolbar-tools-menu"
                  >
                    <ActionMenuButton icon={Upload} onClick={() => importRef.current?.click()}>
                      Importer CSV
                    </ActionMenuButton>
                    <ActionMenuButton icon={Download} onClick={() => setCashExportToolsOpen((current) => !current)}>
                      Exporter
                    </ActionMenuButton>
                  </ActionMenu>
                </div>
              }
            >
              {cashExportToolsOpen ? (
                <div data-testid="cash-export-panel" className="border-b border-[#fed7aa] bg-[#fff7ed] p-3">
                  <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-end 2xl:justify-between">
                    <div className="grid flex-1 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(220px,0.75fr)_minmax(420px,1fr)]">
                      <label
                        className="text-[#475569]"
                        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 800 }}
                      >
                        Format
                        <div
                          className="mt-1 flex h-11 items-center rounded-xl border border-[#fed7aa] bg-white px-3 text-[#0f172a]"
                          style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                        >
                          CSV paiements
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
                            onClick={() => downloadMovementsCsv("tresorerie_mouvements.csv", filteredMovements)}
                            className="rounded-full border border-[#f97316] bg-white px-3 py-1.5 text-[#ea580c] transition-colors hover:bg-[#fff7ed]"
                            style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                          >
                            Vue filtrée · {filteredMovements.length}
                          </button>
                          <button
                            type="button"
                            onClick={() => downloadMovementsCsv("tresorerie_selection.csv", selectedMovements)}
                            disabled={selectedMovements.length === 0}
                            className="rounded-full border border-[#fed7aa] bg-[#fffaf5] px-3 py-1.5 text-[#ea580c] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                            style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                          >
                            Sélection · {selectedMovements.length}
                          </button>
                          {vatSummary ? (
                            <button
                              type="button"
                              onClick={exportVatCsv}
                              className="rounded-full border border-[#fed7aa] bg-[#fffaf5] px-3 py-1.5 text-[#ea580c] transition-colors hover:bg-white"
                              style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
                            >
                              TVA période
                            </button>
                          ) : null}
                        </div>
                      </label>
                    </div>
                    <GuidanceTooltip content="Télécharge les mouvements correspondant au périmètre choisi.">
                      <button
                        type="button"
                        onClick={() =>
                          downloadMovementsCsv(
                            selectedMovements.length > 0 ? "tresorerie_selection.csv" : "tresorerie_mouvements.csv",
                            selectedMovements.length > 0 ? selectedMovements : filteredMovements,
                          )
                        }
                        className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-[#f97316] px-4 text-white shadow-[0_10px_22px_-16px_rgba(234,88,12,0.8)] transition-all hover:-translate-y-[1px] hover:bg-[#ea580c]"
                        style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 900 }}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {selectedMovements.length > 0 ? "Exporter la sélection" : "Exporter la vue filtrée"}
                      </button>
                    </GuidanceTooltip>
                  </div>
                </div>
              ) : null}

              {movements.length === 0 ? (
                <div className="px-5 py-14 text-center">
                  <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f4f6fa]">
                    <Wallet className="h-5 w-5 text-[#cbd5e1]" />
                  </div>
                  <p className="text-[#64748b]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                    Aucun mouvement pour le moment
                  </p>
                  <p className="mt-1 text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                    Ajoutez un paiement ou un achat fournisseur pour alimenter le suivi des paiements.
                  </p>
                  <div className="mt-3 flex flex-wrap justify-center gap-2">
                    <PrimaryLinkButton to="/app/invoices">Voir les factures</PrimaryLinkButton>
                    <SecondaryButton onClick={() => importRef.current?.click()}>
                      <Upload className="h-3.5 w-3.5" /> Importer un relevé CSV
                    </SecondaryButton>
                  </div>
                </div>
              ) : filteredMovements.length === 0 ? (
                <div className="px-5 py-14 text-center">
                  <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f4f6fa]">
                    <Wallet className="h-5 w-5 text-[#cbd5e1]" />
                  </div>
                  <p className="text-[#64748b]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                    Aucun résultat
                  </p>
                  <p className="mt-1 text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                    Modifie la recherche ou reviens à tous les mouvements.
                  </p>
                  {hasActiveFilters ? (
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="mt-1.5 text-[#15803d] transition-colors hover:text-[#166534]"
                      style={{ fontSize: "0.8125rem", fontWeight: 600 }}
                    >
                      Voir tous les mouvements
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="pf-data-table w-full min-w-[980px]">
                    <thead>
                      <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                        <th className="w-[310px] px-3 py-2 text-left" style={{ background: "#fafbfd" }}>
                          <div className="flex items-center gap-3">
                            <span className="flex w-5 shrink-0 justify-center">
                              <input
                                type="checkbox"
                                checked={allPageMovementsSelected}
                                onChange={toggleMovementPageSelection}
                                aria-label="Sélectionner les mouvements de la page"
                                className="h-[15px] w-[15px] rounded border-[#d1dcec]"
                                style={{ accentColor: "#f97316" }}
                              />
                            </span>
                            <CashTableHeader sortKey="movement" sortState={sortState} onSort={toggleSort}>
                              Mouvement
                            </CashTableHeader>
                          </div>
                        </th>
                        {cashTableColumns.map((column) => (
                          <th
                            key={column.key}
                            className="px-3 py-2 text-left"
                            style={{
                              background: "#fafbfd",
                            }}
                          >
                            <CashTableHeader sortKey={column.key} sortState={sortState} onSort={toggleSort}>
                              {column.label}
                            </CashTableHeader>
                          </th>
                        ))}
                        <th
                          className="px-3 py-2 text-left"
                          style={{
                            background: "#fafbfd",
                            color: "#94a3b8",
                            fontSize: "0.625rem",
                            fontWeight: 700,
                            letterSpacing: "0.08em",
                            textTransform: "uppercase",
                          }}
                        />
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((movement) => (
                        <tr key={movement.id} className="transition-colors hover:bg-[#fff7ed]">
                          <td className="px-3 py-2">
                            <div className="flex items-start gap-3">
                              <span className="flex w-5 shrink-0 justify-center pt-1">
                                <input
                                  type="checkbox"
                                  checked={selectedMovementIds.includes(String(movement.id))}
                                  onChange={() => toggleMovementSelection(String(movement.id))}
                                  aria-label={`Sélectionner ${movement.title}`}
                                  className="h-[15px] w-[15px] rounded border-[#d1dcec]"
                                  style={{ accentColor: "#f97316" }}
                                />
                              </span>
                              <div className="min-w-0">
                                <Link
                                  to={movement.href}
                                  className="transition-colors hover:opacity-80"
                                  style={{ color: "#ea580c", fontSize: "0.8125rem", fontWeight: 700 }}
                                >
                                  {movement.title}
                                </Link>
                                <div className="mt-0.5 text-[#94a3b8]" style={{ fontSize: "0.75rem", fontWeight: 400 }}>
                                  {movement.detail}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-[#475569]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                            {formatDateFr(movement.date, "—")}
                          </td>
                          <td className="px-3 py-2 text-[#475569]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                            {movement.relation}
                          </td>
                          <td
                            className={
                              movement.amount >= 0
                                ? "pf-cash-amount-positive px-3 py-2"
                                : "pf-cash-amount-negative px-3 py-2"
                            }
                            style={{ fontSize: "0.9375rem", fontWeight: 800 }}
                          >
                            {signedMoney(movement.amount, movement.currency)}
                          </td>
                          <td className="px-3 py-2 text-[#64748b]" style={{ fontSize: "0.875rem" }}>
                            <div>{movement.source}</div>
                            {movement.origin === "import" ? (
                              <div
                                className="mt-1 inline-flex items-center gap-1 text-[#94a3b8]"
                                style={{ fontSize: "0.6875rem" }}
                              >
                                <Calendar className="h-3 w-3" /> Relevé importé
                              </div>
                            ) : null}
                          </td>
                          <td className="px-3 py-2">
                            <StatusPill status={movement.statusTone} label={movement.statusLabel} />
                          </td>
                          <td className="px-3 py-2 text-right">
                            {movement.origin === "import" && movement.needsReview ? (
                              <button
                                type="button"
                                data-testid="cash-justify-transaction"
                                onClick={() => openJustification(movement)}
                                className="inline-flex items-center justify-center rounded-lg border border-[#fed7aa] bg-[#fff7ed] px-3 py-2 text-xs font-bold text-[#ea580c] transition-colors hover:bg-[#ffedd5]"
                              >
                                Justifier
                              </button>
                            ) : (
                              <Link
                                to={movement.href}
                                className="pf-action-icon pf-action-icon--cash"
                                aria-label={`Ouvrir ${movement.title}`}
                                title="Ouvrir"
                              >
                                <ArrowRight className="h-3.5 w-3.5" />
                              </Link>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <ListPagination
                page={page}
                totalItems={filteredMovements.length}
                pageSize={pageSize}
                pageSizeOptions={CASH_PAGE_SIZE_OPTIONS}
                pageSizeAriaLabel="Mouvements par page"
                itemLabel="mouvement"
                onPageChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPage(1);
                  setPageSize(nextPageSize);
                }}
                action={
                  hasActiveFilters ? (
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="text-xs font-medium text-[#ea580c] transition-colors hover:text-[#c2410c]"
                    >
                      Réinitialiser
                    </button>
                  ) : null
                }
              />
            </SalesListBlock>

            {matchingMovement ? (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-[#0f172a]/35 px-4"
                data-testid="cash-justify-modal"
              >
                <div className="w-full max-w-xl rounded-2xl border border-[#dbe5ef] bg-white shadow-2xl">
                  <div className="flex items-start justify-between gap-4 border-b border-[#edf2f7] px-3 py-2">
                    <div>
                      <div className="text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 850 }}>
                        Justifier le mouvement
                      </div>
                      <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.45 }}>
                        {formatDateFr(matchingMovement.date, "Date inconnue")} ·{" "}
                        {signedMoney(matchingMovement.amount, matchingMovement.currency)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setMatchingMovement(null)}
                      className="rounded-lg border border-[#e2e8f0] px-3 py-2 text-xs font-bold text-[#475569] transition-colors hover:bg-[#f8fafc]"
                    >
                      Fermer
                    </button>
                  </div>
                  <div className="space-y-4 px-5 py-5">
                    <div className="rounded-xl border border-[#edf2f7] bg-[#f8fafc] px-4 py-3">
                      <div className="text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 800 }}>
                        {matchingMovement.relation}
                      </div>
                      <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.45 }}>
                        {matchingMovement.detail}
                      </p>
                    </div>

                    {matchingMovement.kind === "incoming" ? (
                      <label className="block space-y-1.5">
                        <span className="block text-[#64748b]" style={{ fontSize: "0.75rem", fontWeight: 800 }}>
                          Paiement client à rapprocher
                        </span>
                        <select
                          data-testid="cash-match-payment-select"
                          value={matchTargetId}
                          onChange={(event) => setMatchTargetId(event.target.value)}
                          className="w-full rounded-lg border border-[#dbe5ef] bg-white px-3 py-2 text-sm text-[#0f172a] outline-none focus:border-[#16a34a] focus:ring-2 focus:ring-[#16a34a]/15"
                        >
                          <option value="">Sélectionner un paiement</option>
                          {paymentCandidates.map((candidate: { id: string; label: string; stateLabel: string }) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.label} · {candidate.stateLabel}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <label className="block space-y-1.5">
                        <span className="block text-[#64748b]" style={{ fontSize: "0.75rem", fontWeight: 800 }}>
                          Achat à solder
                        </span>
                        <select
                          data-testid="cash-match-purchase-select"
                          value={matchTargetId}
                          onChange={(event) => setMatchTargetId(event.target.value)}
                          className="w-full rounded-lg border border-[#dbe5ef] bg-white px-3 py-2 text-sm text-[#0f172a] outline-none focus:border-[#16a34a] focus:ring-2 focus:ring-[#16a34a]/15"
                        >
                          <option value="">Sélectionner un achat</option>
                          {purchaseCandidates.map((candidate: { id: string; label: string; stateLabel: string }) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.label} · {candidate.stateLabel}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    <label className="block space-y-1.5">
                      <span className="block text-[#64748b]" style={{ fontSize: "0.75rem", fontWeight: 800 }}>
                        Note interne
                      </span>
                      <textarea
                        value={matchNote}
                        onChange={(event) => setMatchNote(event.target.value)}
                        rows={3}
                        placeholder="Optionnel"
                        className="w-full resize-none rounded-lg border border-[#dbe5ef] bg-white px-3 py-2 text-sm text-[#0f172a] outline-none placeholder:text-[#94a3b8] focus:border-[#16a34a] focus:ring-2 focus:ring-[#16a34a]/15"
                      />
                    </label>

                    <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                      <SecondaryButton onClick={() => void justifyImportedMovement("manual")} disabled={matchBusy}>
                        Classer hors achat
                      </SecondaryButton>
                      {matchingMovement.kind === "incoming" ? (
                        <SecondaryButton
                          data-testid="cash-match-payment"
                          onClick={() => void justifyImportedMovement("payment")}
                          disabled={matchBusy || !matchTargetId}
                        >
                          Rapprocher ce paiement
                        </SecondaryButton>
                      ) : (
                        <SecondaryButton
                          data-testid="cash-match-purchase"
                          onClick={() => void justifyImportedMovement("purchase")}
                          disabled={matchBusy || !matchTargetId}
                        >
                          Marquer réglé avec cet achat
                        </SecondaryButton>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        )}
      </WorkbenchPage>
    </div>
  );
}
