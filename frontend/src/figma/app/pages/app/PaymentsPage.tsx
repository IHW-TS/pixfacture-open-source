"use client";

import { useEffect, useMemo, useState } from "react";
import { Link } from "@/figma/react-router-compat";
import { extractUserFacingApiMessage, formatApiError, rawApi } from "@/lib/api";
import { formatDateFr, formatDateTimeFr } from "@/lib/dateFormat";
import { emailDeliveryProof } from "@/lib/emailDeliveryProof";
import {
  AppPageHeader,
  Card,
  PrimaryLinkButton,
  SecondaryButton,
  StatusPill,
} from "../../components/app/AppPageHeader";
import { EmptyCard, NoticeBanner } from "../../components/app/Feedback";
import { WorkbenchPage } from "../../components/app/WorkbenchLayout";
import {
  LIST_PAGE_SIZE_OPTIONS,
  ListPagination,
  paginateList,
  usePersistedListPageSize,
} from "../../components/app/ListPagination";
import {
  SalesListBlock,
  SalesMetricCard,
  SalesMetricsGrid,
  getSalesTheme,
} from "../../components/app/SalesModuleLayout";
import { FileText, RefreshCw, ShieldCheck, Wallet } from "lucide-react";

const money = (value: any, currency = "EUR") =>
  `${Number(value || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency === "EUR" ? "€" : currency}`;

function paymentStatus(row: any, issue: any) {
  const state = String(issue?.quality_state || "").toLowerCase();
  if (state === "missing_justification" || state === "missing_category") return { status: "warn", label: "Justif." };
  if (state === "missing_reference") return { status: "danger", label: "Sans réf." };
  if (state === "missing_metadata" || state === "missing_method") return { status: "warn", label: "À revoir" };
  if (!row?.invoice_id || !row?.invoice_number) return { status: "danger", label: "Sans réf." };
  if (Number(row?.remaining_balance || 0) > 0 || Number(row?.balance_due || 0) > 0)
    return { status: "warn", label: "Partiel" };
  return { status: "ok", label: "Facture réglée" };
}

function settlementLabel(value: any) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "cash") return "Espèces";
  if (normalized === "manual") return "Manuel";
  if (normalized === "bank") return "Banque";
  return "À justifier";
}

function paymentEmailProof(row: any) {
  const proof = emailDeliveryProof(row);
  const dateLabel = proof.date ? formatDateTimeFr(proof.date, "") : "";
  return {
    status: proof.status,
    label: dateLabel && proof.status !== "muted" ? `${proof.shortLabel} · ${dateLabel}` : proof.shortLabel,
    title: proof.title,
  };
}

export function PaymentsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [viewFilter, setViewFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePersistedListPageSize("pixfacture.payments.pageSize.v1");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await rawApi("/api/collections/payments-dashboard");
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(extractUserFacingApiMessage(data, res.status, "Impossible de charger la vue paiements."));
      }
      const data = await res.json().catch(() => null);
      setPayload(data || null);
    } catch (err) {
      setPayload(null);
      setError(formatApiError(err, "Impossible de charger la vue paiements."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const summary = payload?.summary;
  const recentPayments = useMemo(
    () => (Array.isArray(payload?.recent_payments) ? payload.recent_payments : []),
    [payload?.recent_payments],
  );
  const qualityIssues = useMemo(
    () => (Array.isArray(payload?.quality_issues) ? payload.quality_issues : []),
    [payload?.quality_issues],
  );
  const actionQueue = useMemo(
    () => (Array.isArray(payload?.action_queue) ? payload.action_queue : []),
    [payload?.action_queue],
  );
  const qualityByPaymentId = useMemo(
    () => new Map(qualityIssues.map((issue: any) => [issue.payment_id, issue])),
    [qualityIssues],
  );

  const tableRows = useMemo(() => {
    const source = recentPayments.length ? recentPayments : qualityIssues;
    return source.map((row: any) => {
      const issue = qualityByPaymentId.get(row.payment_id);
      return {
        ...row,
        qualityIssue: issue,
        status: paymentStatus(row, issue),
      };
    });
  }, [qualityByPaymentId, qualityIssues, recentPayments]);

  const paymentQualityCount =
    Number(summary?.missing_reference_count || 0) +
    Number(summary?.missing_method_count || 0) +
    Number(summary?.missing_justification_count || 0);
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tableRows.filter((row: any) => {
      const matchesFilter =
        viewFilter === "all"
          ? true
          : viewFilter === "ok"
            ? row.status?.status === "ok"
            : viewFilter === "warn"
              ? row.status?.status === "warn"
              : row.status?.status === "danger";
      if (!matchesFilter) return false;
      if (!q) return true;
      return [
        row.reference,
        row.invoice_number,
        row.customer_name,
        row.method,
        row.settlement_mode,
        row.accounting_category,
        row.receipt_label,
        row.status?.label,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [search, tableRows, viewFilter]);
  const pageRows = useMemo(() => paginateList(filteredRows, page, pageSize), [filteredRows, page, pageSize]);

  useEffect(() => {
    setPage(1);
  }, [search, viewFilter]);
  const okCount = tableRows.filter((row: any) => row.status?.status === "ok").length;
  const warnCount = tableRows.filter((row: any) => row.status?.status === "warn").length;
  const reviewCount = tableRows.filter((row: any) => row.status?.status === "danger").length;
  const paymentTabs = useMemo(
    () => [
      { value: "all", label: "Tous", count: tableRows.length },
      { value: "ok", label: "Réglés", count: okCount },
      { value: "warn", label: "Partiels", count: warnCount },
      { value: "danger", label: "À revoir", count: reviewCount },
    ],
    [okCount, reviewCount, tableRows.length, warnCount],
  );
  const theme = getSalesTheme("payments");
  const matchedOkCount = okCount;

  const resetFilters = () => {
    setSearch("");
    setViewFilter("all");
  };

  const filteredCountLabel = `${filteredRows.length} paiement${filteredRows.length > 1 ? "s" : ""}`;
  const hasActiveFilters = viewFilter !== "all" || search.trim().length > 0;

  return (
    <div>
      <AppPageHeader
        title="Paiements"
        breadcrumb="Trésorerie"
        description="Contrôle manuel des encaissements enregistrés sur les factures."
        actions={
          <div className="flex items-center gap-2">
            <SecondaryButton>
              <Link to="/app/cash">Trésorerie</Link>
            </SecondaryButton>
            <SecondaryButton onClick={() => void load()}>
              <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
            </SecondaryButton>
          </div>
        }
      />
      <WorkbenchPage>
        {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
        <NoticeBanner tone="info" title="Paiements sans banque connectée">
          Cette page vérifie les paiements déjà saisis ou liés aux factures. Sans connexion bancaire, rapproche les
          règlements avec leur référence, leur mode et leur facture.
        </NoticeBanner>

        {loading ? (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <Card key={index} className="min-h-[132px]">
                  <div className="animate-pulse space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="h-2.5 w-20 rounded-full bg-[#e2e8f0]" />
                      <div className="h-8 w-8 rounded-2xl bg-[#eef2ff]" />
                    </div>
                    <div className="h-8 w-24 rounded-xl bg-[#e5e7eb]" />
                    <div className="h-2.5 w-28 rounded-full bg-[#f1f5f9]" />
                  </div>
                </Card>
              ))}
            </div>
            <Card>
              <div className="animate-pulse space-y-4">
                <div className="flex items-center justify-between">
                  <div className="h-4 w-56 rounded-full bg-[#e2e8f0]" />
                  <div className="h-6 w-20 rounded-full bg-[#fee2e2]" />
                </div>
                <div className="h-14 w-full rounded-2xl bg-[#f8fafc]" />
              </div>
            </Card>
            <div className="animate-pulse space-y-3">
              <div className="h-3 w-36 rounded-full bg-[#e2e8f0]" />
              <div className="overflow-hidden rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06),0_8px_24px_rgba(0,0,0,0.04)]">
                <div className="overflow-x-auto">
                  <table className="pf-data-table w-full">
                    <thead>
                      <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                        {["Date", "Référence", "Montant", "Facture", "Client", "Mode", "Statut"].map(
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
                      {Array.from({ length: 5 }).map((_, index) => (
                        <tr key={index} className="border-b border-[#eef2f7] last:border-b-0">
                          {Array.from({ length: 7 }).map((__, cell) => (
                            <td key={cell} className="px-5 py-4">
                              <div
                                className={`h-3 rounded-full bg-[#f1f5f9] ${cell === 2 ? "w-20" : cell === 4 ? "w-24" : "w-14"}`}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </>
        ) : !payload ? (
          <EmptyCard
            compact
            className="border-dashed border-[#dbe5ef] shadow-none"
            title="Aucun paiement à afficher"
            description="Les règlements apparaîtront ici dès qu'ils seront enregistrés sur les factures."
            action={<PrimaryLinkButton to="/app/invoices">Voir les factures</PrimaryLinkButton>}
          />
        ) : (
          <>
            <SalesMetricsGrid>
              <SalesMetricCard
                tone="payments"
                density="client"
                label="Encaissé 30j"
                value={money(summary?.collected_last_30_days || 0)}
                detail={`${Number(summary?.payments_count_last_30_days || 0)} mouvement(s)`}
                icon={<Wallet className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="payments"
                density="client"
                accent="warning"
                label="En attente"
                value={money(summary?.open_balance_due || 0)}
                detail={`${Number(summary?.open_invoice_count || 0)} facture(s) ouvertes`}
                icon={<FileText className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="payments"
                density="client"
                accent="success"
                label="Réglés"
                value={matchedOkCount}
                detail="Factures soldées"
                icon={<ShieldCheck className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="payments"
                density="client"
                accent="danger"
                label="À revoir"
                value={paymentQualityCount}
                detail="Justif., références ou modes manquants"
                icon={<RefreshCw className="h-4 w-4" />}
              />
            </SalesMetricsGrid>

            {actionQueue.length > 0 ? (
              <Card>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 800 }}>
                      Actions paiement à traiter
                    </div>
                    <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.45 }}>
                      Factures en retard, liens client et paiements à rapprocher sans attendre une connexion bancaire.
                    </p>
                  </div>
                  <StatusPill
                    status="warn"
                    label={`${actionQueue.length} action${actionQueue.length > 1 ? "s" : ""}`}
                  />
                </div>
                <div className="mt-4 divide-y divide-[#eef2f7]">
                  {actionQueue.slice(0, 5).map((action: any) => {
                    const emailProof = paymentEmailProof(action);
                    return (
                      <div
                        key={action.invoice_id}
                        className="grid gap-3 py-3 sm:grid-cols-[1fr_auto_auto] sm:items-center"
                      >
                        <div className="min-w-0">
                          <Link
                            to={`/app/invoices/${action.invoice_id}`}
                            className="truncate text-[#1d4ed8] transition-colors hover:text-[#1e40af]"
                            style={{ fontSize: "0.875rem", fontWeight: 800 }}
                          >
                            {action.invoice_number || action.invoice_id}
                          </Link>
                          <div className="mt-0.5 truncate text-[#64748b]" style={{ fontSize: "0.8125rem" }}>
                            {action.customer_name || "Client"} · {action.days_overdue || 0} j retard ·{" "}
                            {action.next_step || "Action à décider"}
                          </div>
                        </div>
                        <div className="text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 850 }}>
                          {money(action.balance_due || 0, action.currency || "EUR")}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                          <StatusPill status={emailProof.status as any} label={emailProof.label} />
                          <Link
                            to={`/app/invoices/${action.invoice_id}`}
                            className="text-[#1d4ed8] transition-colors hover:text-[#1e40af]"
                            style={{ fontSize: "0.8125rem", fontWeight: 700 }}
                            title={emailProof.title}
                          >
                            Ouvrir
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            ) : null}

            <div className="space-y-5">
              <SalesListBlock
                tone="payments"
                density="client"
                filters={paymentTabs.map((item) => ({
                  value: item.value,
                  label: item.label,
                  count: item.count,
                  accent:
                    item.value === "ok"
                      ? "success"
                      : item.value === "warn"
                        ? "warning"
                        : item.value === "danger"
                          ? "danger"
                          : "module",
                }))}
                filterValue={viewFilter}
                onFilterChange={(value) => setViewFilter(value)}
                searchValue={search}
                onSearchChange={(value) => setSearch(value)}
                searchPlaceholder="Réf, facture, client..."
                searchWidth="18rem"
              >
                {tableRows.length === 0 ? (
                  <div className="px-5 py-14 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f4f6fa]">
                        <Wallet className="h-5 w-5 text-[#cbd5e1]" />
                      </div>
                      <p className="text-[#64748b]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                        Aucun résultat
                      </p>
                      <p className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                        Les encaissements, factures soldées et paiements à vérifier apparaîtront ici au fil des
                        règlements.
                      </p>
                    </div>
                  </div>
                ) : filteredRows.length === 0 ? (
                  <div className="px-5 py-14 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f4f6fa]">
                        <Wallet className="h-5 w-5 text-[#cbd5e1]" />
                      </div>
                      <p className="text-[#64748b]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                        Aucun résultat
                      </p>
                      <p className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                        {search ? `"${search}" ne correspond à aucun paiement` : "Aucun paiement dans cette catégorie"}
                      </p>
                      {hasActiveFilters ? (
                        <button
                          type="button"
                          onClick={resetFilters}
                          className="mt-1 text-[#ea580c] transition-colors hover:text-[#c2410c]"
                          style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                        >
                          Voir tous les paiements
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="pf-data-table w-full">
                      <thead>
                        <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                          {["Date", "Référence", "Montant", "Facture", "Client", "Mode", "Statut"].map(
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
                        {pageRows.map((payment: any) => {
                          return (
                            <tr key={payment.payment_id} className="hover:bg-[#fffaf5] transition-colors">
                              <td
                                className="px-5 py-4 text-[#475569]"
                                style={{ fontSize: "0.875rem", fontWeight: 500 }}
                              >
                                {formatDateFr(payment.date, "—")}
                              </td>
                              <td className="px-5 py-4 font-mono text-[#374151]" style={{ fontSize: "0.75rem" }}>
                                {payment.reference || payment.receipt_label || "—"}
                              </td>
                              <td
                                className="px-5 py-4 text-[#0f172a]"
                                style={{ fontSize: "0.9375rem", fontWeight: 800 }}
                              >
                                {money(payment.amount || 0, payment.currency || "EUR")}
                              </td>
                              <td className="px-5 py-4">
                                {payment.invoice_id ? (
                                  <Link
                                    to={`/app/invoices/${payment.invoice_id}`}
                                    className="transition-colors hover:opacity-80"
                                    style={{ color: theme.strong, fontSize: "0.8125rem", fontWeight: 700 }}
                                  >
                                    {payment.invoice_number || payment.invoice_id}
                                  </Link>
                                ) : (
                                  <span className="text-[#94a3b8]" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                                    —
                                  </span>
                                )}
                              </td>
                              <td className="px-5 py-4 text-[#475569]" style={{ fontSize: "0.875rem" }}>
                                {payment.customer_name || "—"}
                              </td>
                              <td className="px-5 py-4 text-[#475569]" style={{ fontSize: "0.875rem" }}>
                                <div className="font-semibold text-[#334155]">
                                  {settlementLabel(payment.settlement_mode)}
                                </div>
                                <div className="mt-0.5 text-[#94a3b8]" style={{ fontSize: "0.72rem" }}>
                                  {payment.accounting_category || payment.method || "—"}
                                </div>
                              </td>
                              <td className="px-5 py-4">
                                <StatusPill
                                  status={payment.status.status as any}
                                  label={payment.qualityIssue?.quality_label || payment.status.label}
                                />
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
                  totalItems={filteredRows.length}
                  pageSize={pageSize}
                  pageSizeOptions={LIST_PAGE_SIZE_OPTIONS}
                  itemLabel="paiement"
                  onPageChange={setPage}
                  onPageSizeChange={(nextPageSize) => {
                    setPage(1);
                    setPageSize(nextPageSize);
                  }}
                  pageSizeAriaLabel="Paiements par page"
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
            </div>
          </>
        )}
      </WorkbenchPage>
    </div>
  );
}
