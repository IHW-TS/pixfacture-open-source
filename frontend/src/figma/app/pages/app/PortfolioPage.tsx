"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { Link } from "@/figma/react-router-compat";
import { formatApiError, rawApi } from "@/lib/api";
import { formatDateFr } from "@/lib/dateFormat";
import { resolveProFeatureGate } from "@/lib/productCapabilities";
import { useSession } from "@/lib/useSession";
import { AnimatePresence, motion } from "motion/react";
import {
  AppPageHeader,
  Card,
  DisclosureCard,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  StatusPill,
} from "../../components/app/AppPageHeader";
import { NoticeBanner, EmptyCard, LoadingCard } from "../../components/app/Feedback";
import { UpgradeNoticeCard } from "../../components/app/UpgradeNoticeCard";
import { WorkbenchPage } from "../../components/app/WorkbenchLayout";
import { SalesListBlock, SalesMetricCard, SalesMetricsGrid } from "../../components/app/SalesModuleLayout";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  CreditCard,
  FileText,
  Flame,
  ListTodo,
  Mail,
  Megaphone,
  RefreshCw,
  Send,
  Shield,
  Sparkles,
  TrendingUp,
  Users,
  X,
} from "lucide-react";

/* ══════════════════════════════════════════════════════════
   Constants & Helpers
   ══════════════════════════════════════════════════════════ */

const SEGMENTS = ["at_risk", "watchlist", "top_accounts", "new_business", "dormant", "stable"] as const;

type PortfolioPillTone = "ok" | "warn" | "danger" | "muted" | "info" | "purple";

const SEG_META: Record<string, { label: string; icon: any; accent: string; dot: string; tone: PortfolioPillTone }> = {
  at_risk: { label: "À risque", icon: AlertTriangle, accent: "#dc2626", dot: "#f87171", tone: "danger" },
  watchlist: { label: "Sous surveillance", icon: Flame, accent: "#d97706", dot: "#fbbf24", tone: "warn" },
  top_accounts: { label: "Comptes clés", icon: TrendingUp, accent: "#7c3aed", dot: "#a78bfa", tone: "purple" },
  new_business: { label: "Nouveaux clients", icon: Users, accent: "#2563eb", dot: "#60a5fa", tone: "info" },
  dormant: { label: "Dormants", icon: CalendarClock, accent: "#6366f1", dot: "#818cf8", tone: "info" },
  stable: { label: "Stables", icon: CheckCircle2, accent: "#16a34a", dot: "#4ade80", tone: "ok" },
};

const TIMELINE_ICONS: Record<string, any> = {
  invoice: FileText,
  payment: CreditCard,
  quote: FileText,
  overdue: AlertTriangle,
  task: ListTodo,
  campaign: Megaphone,
  portal: Shield,
  followup: Send,
  customer: Users,
};

type SortKey =
  | "customer_name"
  | "open_balance"
  | "overdue_balance"
  | "revenue_12m"
  | "average_days_to_pay"
  | "risk_level"
  | "days_since_last_activity";
type SortDir = "asc" | "desc";

const PAGE_SIZE = 10;

function money(v: any) {
  return `${Number(v || 0).toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })} €`;
}

function daysAgoLabel(days: number | null | undefined) {
  if (days == null || days < 0) return "—";
  if (days === 0) return "Aujourd'hui";
  if (days === 1) return "Hier";
  if (days <= 7) return `${days} j`;
  if (days <= 30) return `${Math.round(days / 7)} sem.`;
  return `${Math.round(days / 30)} mois`;
}

function pluralize(count: number, singular: string, plural?: string) {
  return `${count} ${count > 1 ? plural || `${singular}s` : singular}`;
}

function clientCountLabel(count: number) {
  return pluralize(count, "client");
}

function sensitiveAccountCountLabel(count: number) {
  return pluralize(count, "compte", "comptes");
}

function sensitiveAccountStatusLabel(count: number) {
  return `${sensitiveAccountCountLabel(count)} ${count > 1 ? "sensibles" : "sensible"}`;
}

function invoiceCountLabel(count: number) {
  return pluralize(count, "facture");
}

function campaignCountLabel(count: number) {
  return pluralize(count, "campagne");
}

function customerInitials(name: string | null | undefined) {
  const clean = String(name || "")
    .replace(/\[DEMO\]\s*/g, "")
    .trim();
  if (!clean) return "?";
  const parts = clean.split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

/* ── Micro-components ──────────────────────────────────── */

function Paginator({ page, totalPages, count, total, onPrev, onNext }: any) {
  return (
    <div className="flex items-center justify-between pt-1">
      <span className="text-[#94a3b8] text-xs">
        {clientCountLabel(count)} sur {total}
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

function TimelineEvent({ event }: any) {
  const Icon = TIMELINE_ICONS[event.kind] || FileText;
  const toneColors: Record<string, string> = {
    ok: "#059669",
    info: "#2563eb",
    warn: "#d97706",
    danger: "#dc2626",
    purple: "#7c3aed",
    muted: "#64748b",
  };
  const color = toneColors[event.tone] || "#64748b";
  return (
    <div className="flex gap-3 py-2">
      <div className="flex flex-col items-center flex-shrink-0">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: `${color}14` }}>
          <Icon className="h-3.5 w-3.5" style={{ color }} />
        </div>
        <div className="flex-1 w-px bg-[#e2e8f0] mt-1" />
      </div>
      <div className="min-w-0 pb-1">
        <div className="text-[0.8125rem] font-semibold text-[#0f172a] leading-tight">{event.title}</div>
        {event.subtitle && <div className="text-[0.6875rem] text-[#64748b] mt-0.5 line-clamp-1">{event.subtitle}</div>}
        <div className="text-[0.625rem] text-[#94a3b8] mt-0.5 tabular-nums">
          {event.occurred_at ? formatDateFr(event.occurred_at, "—") : "—"}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   Main Page
   ══════════════════════════════════════════════════════════ */

export function PortfolioPage() {
  const { capabilities, loading: sessionLoading } = useSession();
  const paymentsGate = resolveProFeatureGate(capabilities, "payments");
  const paymentsEnabled = paymentsGate.enabled;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [payload, setPayload] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [activeSegment, setActiveSegment] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("open_balance");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [page, setPage] = useState(1);

  const [drawerCustomerId, setDrawerCustomerId] = useState<string | null>(null);
  const [drawerData, setDrawerData] = useState<any>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"overview" | "timeline">("overview");

  /* ── Data Loading ─────────────────────────────────────── */
  const load = useCallback(async () => {
    if (sessionLoading || !paymentsEnabled) {
      setLoading(false);
      setError(null);
      setPayload(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await rawApi("/api/ops/customer-portfolio");
      const data = await res.json().catch(() => null);
      if (!res.ok) throw data || new Error("Portefeuille indisponible.");
      setPayload(data || null);
    } catch (err) {
      setPayload(null);
      setError(formatApiError(err, "Impossible de charger le portefeuille."));
    } finally {
      setLoading(false);
    }
  }, [paymentsEnabled, sessionLoading]);

  useEffect(() => {
    if (sessionLoading || !paymentsEnabled) return;
    void load();
  }, [paymentsEnabled, refreshNonce, load, sessionLoading]);

  const openDrawer = useCallback(
    async (customerId: string) => {
      if (!paymentsEnabled) return;
      setDrawerCustomerId(customerId);
      setDrawerTab("overview");
      setDrawerLoading(true);
      setDrawerData(null);
      try {
        const res = await rawApi(`/api/ops/customer-portfolio/${encodeURIComponent(customerId)}`);
        const data = await res.json().catch(() => null);
        if (!res.ok) throw data || new Error("Détail indisponible.");
        setDrawerData(data);
      } catch {
        setDrawerData(null);
      } finally {
        setDrawerLoading(false);
      }
    },
    [paymentsEnabled],
  );

  const closeDrawer = () => {
    setDrawerCustomerId(null);
    setDrawerData(null);
  };

  /* ── Derived Data ─────────────────────────────────────── */
  const items = useMemo<any[]>(() => (Array.isArray(payload?.items) ? payload.items : []), [payload?.items]);
  const summary = payload?.summary || {};
  const segments = useMemo<any[]>(
    () => (Array.isArray(payload?.segments) ? payload.segments : []),
    [payload?.segments],
  );
  const campaigns = useMemo<any[]>(
    () => (Array.isArray(payload?.campaigns) ? payload.campaigns : []),
    [payload?.campaigns],
  );

  const segmentCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const seg of SEGMENTS) counts[seg] = 0;
    for (const item of items) {
      if (counts[item.segment] != null) counts[item.segment]++;
    }
    return counts;
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    let filtered = items;
    if (activeSegment) filtered = filtered.filter((i) => i.segment === activeSegment);
    if (q) {
      filtered = filtered.filter((item) => {
        const haystack = [item.customer_name, item.customer_email, item.segment_label, item.risk_label]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }
    filtered = [...filtered].sort((a, b) => {
      let av = a[sortKey],
        bv = b[sortKey];
      if (sortKey === "customer_name") {
        av = String(av || "").toLowerCase();
        bv = String(bv || "").toLowerCase();
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      if (sortKey === "risk_level") {
        const riskOrder: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
        av = riskOrder[av] || 0;
        bv = riskOrder[bv] || 0;
      } else {
        av = Number(av || 0);
        bv = Number(bv || 0);
      }
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return filtered;
  }, [items, activeSegment, search, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const pageItems = useMemo(() => filteredItems.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filteredItems, page]);

  useEffect(() => {
    setPage(1);
  }, [activeSegment, search]);

  const riskClusterCount = Number(summary.at_risk_count || 0) + Number(summary.watchlist_count || 0);

  /* ── Drawer data ──────────────────────────────────────── */
  const drawerItem = drawerData?.item || items.find((i: any) => i.customer_id === drawerCustomerId) || null;
  const drawerTimeline: any[] = Array.isArray(drawerData?.timeline) ? drawerData.timeline : [];
  const drawerPeers: any[] = Array.isArray(drawerData?.peer_items) ? drawerData.peer_items : [];
  const drawerTasks: any[] = Array.isArray(drawerData?.active_tasks) ? drawerData.active_tasks : [];

  /* ══════════════════════════════════════════════════════════
     Render
     ══════════════════════════════════════════════════════════ */
  if (!sessionLoading && !paymentsEnabled) {
    return (
      <div>
        <AppPageHeader
          title="Portefeuille"
          breadcrumb="Avancé"
          description="Encours, retards et délais de paiement sont disponibles avec le plan Pro."
        />
        <WorkbenchPage>
          <UpgradeNoticeCard
            title={
              paymentsGate.reactivationRequired
                ? paymentsGate.statusLabel
                : "Portefeuille de paiements disponible avec le plan Pro"
            }
            description={
              paymentsGate.reactivationDescription ||
              "Starter reste centré sur les clients, devis et factures classiques. Passez à Pro pour suivre les encours, les retards et les délais de paiement."
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
        title="Portefeuille"
        breadcrumb="Avancé"
        description="Vue consolidée des comptes clients, priorités de suivi et actions à engager."
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/app/customers"
              className="inline-flex items-center gap-2 rounded-xl border border-[#d9e4f0] bg-white px-3 py-2 text-[0.78rem] font-semibold text-[#334155] transition-all hover:border-[#cbd5e1] hover:bg-[#f8fafc]"
            >
              <Users className="h-3.5 w-3.5 text-[#475569]" />
              Annuaire
            </Link>
            <Link
              to="/app/tasks"
              className="inline-flex items-center gap-2 rounded-xl border border-[#d9e4f0] bg-white px-3 py-2 text-[0.78rem] font-semibold text-[#334155] transition-all hover:border-[#cbd5e1] hover:bg-[#f8fafc]"
            >
              <ListTodo className="h-3.5 w-3.5 text-[#475569]" />
              Tâches
            </Link>
            <SecondaryButton onClick={() => setRefreshNonce((v) => v + 1)}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Rafraîchir
            </SecondaryButton>
          </div>
        }
      />

      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        <WorkbenchPage>
          {error ? <NoticeBanner tone="warning">{error}</NoticeBanner> : null}
          {notice ? (
            <NoticeBanner tone="success">
              {notice}
              <button type="button" onClick={() => setNotice(null)} className="ml-2 opacity-60 hover:opacity-100">
                <X className="w-3.5 h-3.5 inline" />
              </button>
            </NoticeBanner>
          ) : null}

          <div className="space-y-4">
            <SalesMetricsGrid>
              <SalesMetricCard
                tone="portfolio"
                density="client"
                accent="info"
                label="Clients suivis"
                value={items.length}
                detail={
                  Number(summary.customers_with_overdue || 0) > 0
                    ? clientCountLabel(Number(summary.customers_with_overdue || 0)) + " en retard"
                    : "Portefeuille actif"
                }
                icon={<Users className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="portfolio"
                density="client"
                label="Encours"
                value={money(summary.open_balance)}
                detail={
                  Number(summary.customers_with_overdue || 0) > 0
                    ? `${clientCountLabel(Number(summary.customers_with_overdue || 0))} en retard`
                    : "Aucun retard"
                }
                icon={<CreditCard className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="portfolio"
                density="client"
                accent={Number(summary.overdue_balance || 0) > 0 ? "warning" : "success"}
                label="Retard"
                value={money(summary.overdue_balance)}
                detail={Number(summary.overdue_balance || 0) > 0 ? "À traiter" : "RAS"}
                icon={<AlertTriangle className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="portfolio"
                density="client"
                accent={riskClusterCount > 0 ? "danger" : "muted"}
                label="Comptes sensibles"
                value={riskClusterCount}
                detail={riskClusterCount > 0 ? sensitiveAccountStatusLabel(riskClusterCount) : "Aucun cluster critique"}
                icon={<Sparkles className="h-4 w-4" />}
              />
            </SalesMetricsGrid>
          </div>

          <SalesListBlock
            tone="portfolio"
            density="client"
            filters={[
              { value: "__all__", label: "Toutes", count: items.length, accent: "module" },
              ...SEGMENTS.filter((segKey) => Number(segmentCounts[segKey] || 0) > 0).map((segKey) => {
                const accent: "danger" | "warning" | "purple" | "success" | "info" =
                  segKey === "at_risk"
                    ? "danger"
                    : segKey === "watchlist"
                      ? "warning"
                      : segKey === "top_accounts"
                        ? "purple"
                        : segKey === "stable"
                          ? "success"
                          : "info";

                return {
                  value: segKey,
                  label: SEG_META[segKey].label,
                  count: segmentCounts[segKey] || 0,
                  accent,
                };
              }),
            ]}
            filterValue={activeSegment || "__all__"}
            onFilterChange={(value) =>
              setActiveSegment(value === "__all__" ? null : (value as (typeof SEGMENTS)[number]))
            }
            searchValue={search}
            onSearchChange={(value) => setSearch(value)}
            searchPlaceholder="Nom, email ou segment…"
            searchWidth="26rem"
            rightExtras={
              <>
                {campaigns.length > 0 ? (
                  <Link
                    to="/app/campaigns"
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-white transition-all"
                    style={{
                      fontSize: "0.8125rem",
                      fontWeight: 600,
                      background: "linear-gradient(135deg,#15803d 0%,#16a34a 100%)",
                      boxShadow: "0 1px 4px rgba(21,128,61,0.2)",
                    }}
                  >
                    <Megaphone className="h-3.5 w-3.5" />
                    Campagnes
                  </Link>
                ) : null}
                <div className="flex items-center gap-1 rounded-lg border border-[#dbe5ef] bg-white px-3 py-1.5 shadow-[0_8px_18px_-16px_rgba(15,23,42,0.18)]">
                  <span className="text-[0.65rem] font-bold uppercase tracking-[0.08em] text-[#94a3b8]">Tri</span>
                  <select
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as SortKey)}
                    className="bg-transparent pr-1 text-[0.75rem] font-medium text-[#475569] outline-none"
                  >
                    <option value="customer_name">Client</option>
                    <option value="open_balance">Encours</option>
                    <option value="risk_level">Risque</option>
                    <option value="days_since_last_activity">Activité</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => setSortDir((dir) => (dir === "asc" ? "desc" : "asc"))}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-[#64748b] hover:bg-[#f8fafc]"
                    title={sortDir === "asc" ? "Tri croissant" : "Tri décroissant"}
                  >
                    {sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                  </button>
                </div>
              </>
            }
          >
            {loading ? (
              <div className="px-4 py-4 lg:px-5">
                <LoadingCard label="Chargement du portefeuille…" />
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="px-5 py-14 text-center">
                <div className="flex flex-col items-center gap-2">
                  <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f4f6fa]">
                    <Users className="h-5 w-5 text-[#cbd5e1]" />
                  </div>
                  <p className="text-[#64748b]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                    Aucun client trouvé
                  </p>
                  <p className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                    {search
                      ? `"${search}" ne correspond à aucun client`
                      : activeSegment
                        ? "Aucun client dans ce segment."
                        : "Aucun client dans le portefeuille."}
                  </p>
                  {activeSegment || search ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSearch("");
                        setActiveSegment(null);
                      }}
                      className="mt-1 text-[#0f766e] transition-colors hover:text-[#115e59]"
                      style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                    >
                      Voir tout le portefeuille
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <div className="min-w-[860px]">
                    <div className="grid grid-cols-[minmax(260px,1.55fr)_170px_150px_160px_80px] border-b border-[#f1f5f9] bg-[#fafbfd] px-4 py-3.5 text-[0.625rem] font-bold uppercase tracking-[0.08em] text-[#94a3b8]">
                      <div>Client</div>
                      <div>Factures</div>
                      <div>Encours</div>
                      <div>Suivi</div>
                      <div />
                    </div>
                    {pageItems.map((item, index) => {
                      const overdue = Number(item.overdue_balance || 0);
                      const riskTone =
                        item.risk_level === "critical" || item.risk_level === "high"
                          ? "danger"
                          : item.risk_level === "medium"
                            ? "warn"
                            : "ok";
                      return (
                        <button
                          key={item.customer_id}
                          type="button"
                          className={`group grid w-full grid-cols-[minmax(260px,1.55fr)_170px_150px_160px_80px] items-center px-4 py-3 text-left transition-colors hover:bg-[#f8fafc] ${
                            index < pageItems.length - 1 ? "border-b border-[#f1f5f9]" : ""
                          }`}
                          onClick={() => openDrawer(item.customer_id)}
                        >
                          <div className="flex min-w-0 items-center gap-2.5">
                            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#1d4ed8]/10 to-[#7c3aed]/10">
                              <span className="text-[0.6875rem] font-bold text-[#1d4ed8]">
                                {customerInitials(item.customer_name)}
                              </span>
                            </div>
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-[#0f172a]">{item.customer_name}</div>
                              <div className="truncate text-[0.6875rem] text-[#8ca0b3]">
                                {item.customer_email || "Sans email"}
                              </div>
                            </div>
                          </div>

                          <div className="pr-4">
                            <div className="text-sm font-semibold tabular-nums text-[#0f172a]">
                              {invoiceCountLabel(Number(item.invoice_count_total || 0))}
                            </div>
                            <div className="mt-0.5 text-[0.6875rem] text-[#8ca0b3]">
                              {Number(item.unpaid_invoice_count || 0) > 0
                                ? String(Number(item.unpaid_invoice_count || 0)) +
                                  " impayée" +
                                  (Number(item.unpaid_invoice_count || 0) > 1 ? "s" : "")
                                : "Aucune impayée"}
                            </div>
                          </div>

                          <div>
                            <div className="text-sm font-semibold tabular-nums text-[#0f172a]">
                              {money(item.open_balance)}
                            </div>
                            <div className="mt-0.5 text-[0.6875rem] tabular-nums text-[#8ca0b3]">
                              {overdue > 0 ? (
                                <span className="font-medium text-[#dc2626]">Retard {money(overdue)}</span>
                              ) : Number(item.unpaid_invoice_count || 0) > 0 ? (
                                invoiceCountLabel(Number(item.unpaid_invoice_count || 0))
                              ) : (
                                "Aucun retard"
                              )}
                            </div>
                          </div>

                          <div>
                            <StatusPill status={riskTone} label={item.risk_label || item.risk_level || "—"} />
                            <div
                              title={
                                item.last_activity_at
                                  ? `Dernière activité : ${formatDateFr(item.last_activity_at, "—")}`
                                  : "Aucune activité récente"
                              }
                              className={`mt-0.5 text-[0.6875rem] tabular-nums ${(item.days_since_last_activity || 999) > 30 ? "font-semibold text-[#d97706]" : "text-[#8ca0b3]"}`}
                            >
                              {daysAgoLabel(item.days_since_last_activity)}
                            </div>
                          </div>

                          <div className="flex justify-end">
                            <span className="inline-flex items-center gap-1 text-[0.75rem] font-medium text-[#1d4ed8] transition-colors group-hover:text-[#1e40af]">
                              Ouvrir <ArrowUpRight className="h-3 w-3" />
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="border-t border-[#eef2f7] px-4 py-2.5 lg:px-5">
                  {totalPages > 1 ? (
                    <Paginator
                      page={page}
                      totalPages={totalPages}
                      count={pageItems.length}
                      total={filteredItems.length}
                      onPrev={() => setPage((c) => Math.max(1, c - 1))}
                      onNext={() => setPage((c) => Math.min(totalPages, c + 1))}
                    />
                  ) : (
                    <div className="text-[0.75rem] text-[#94a3b8]">
                      {filteredItems.length} client{filteredItems.length > 1 ? "s" : ""}
                    </div>
                  )}
                </div>
              </>
            )}
          </SalesListBlock>

          {/* ── Campaigns ── */}
          {campaigns.length > 0 && (
            <DisclosureCard
              title={`Campagnes actives (${campaigns.length})`}
              description="Vos campagnes en cours sur le portefeuille."
              defaultOpen={false}
              collapsible={false}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                {campaigns.map((c: any) => (
                  <Link
                    key={c.id}
                    to={c.href || "/app/campaigns"}
                    className="flex items-center gap-3 rounded-xl border border-[#e2e8f0] bg-[#f8fafc] p-3.5 hover:border-[#c7d2fe] hover:shadow-sm transition-all cursor-pointer"
                  >
                    <StatusPill status={c.tone || "muted"} label={c.status_label || c.status} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-[#0f172a] truncate">{c.name}</div>
                      <div className="text-[0.6875rem] text-[#94a3b8]">
                        {c.customer_count} client{(c.customer_count || 0) > 1 ? "s" : ""}
                      </div>
                    </div>
                    <ChevronRight className="w-3.5 h-3.5 text-[#cbd5e1] flex-shrink-0" />
                  </Link>
                ))}
              </div>
            </DisclosureCard>
          )}
        </WorkbenchPage>
      </motion.div>

      {/* ══════════════════════════════════════════════════════
         DETAIL DRAWER
         ══════════════════════════════════════════════════════ */}
      <AnimatePresence>
        {drawerCustomerId && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-[#0f172a]/38 backdrop-blur-[6px]"
              onClick={closeDrawer}
            />
            <motion.aside
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 30, stiffness: 300 }}
              className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[540px] flex-col bg-white shadow-2xl"
            >
              {drawerLoading ? (
                <div className="flex-1 flex items-center justify-center">
                  <LoadingCard label="Chargement du détail…" />
                </div>
              ) : drawerItem ? (
                <>
                  {/* Drawer Header */}
                  <div className="flex-shrink-0 border-b border-[#e2e8f0] px-6 pt-6 pb-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="text-lg font-[750] text-[#0f172a] truncate leading-tight">
                          {drawerItem.customer_name}
                        </div>
                        {drawerItem.customer_email && (
                          <div className="flex items-center gap-1 text-xs text-[#64748b] mt-1 truncate">
                            <Mail className="w-3 h-3 flex-shrink-0" />
                            {drawerItem.customer_email}
                          </div>
                        )}
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          <StatusPill
                            status={SEG_META[drawerItem.segment]?.tone || "muted"}
                            label={SEG_META[drawerItem.segment]?.label || drawerItem.segment_label || "—"}
                          />
                          <StatusPill
                            status={
                              drawerItem.risk_level === "critical" || drawerItem.risk_level === "high"
                                ? "danger"
                                : drawerItem.risk_level === "medium"
                                  ? "warn"
                                  : "ok"
                            }
                            label={drawerItem.risk_label || drawerItem.risk_level || "—"}
                          />
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={closeDrawer}
                        className="flex-shrink-0 flex h-8 w-8 items-center justify-center rounded-lg bg-[#f4f6fa] hover:bg-[#e2e8f0] transition-colors"
                      >
                        <X className="h-4 w-4 text-[#475569]" />
                      </button>
                    </div>

                    <div className="mt-4 flex gap-1 rounded-xl border border-[#dbeafe] bg-[#eff6ff] p-0.5">
                      {[
                        { key: "overview" as const, label: "Vue d'ensemble", icon: BarChart3 },
                        { key: "timeline" as const, label: `Historique (${drawerTimeline.length})`, icon: Clock },
                      ].map(({ key, label, icon: TabIcon }) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setDrawerTab(key)}
                          className={`flex-1 flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[0.65rem] font-semibold leading-none transition-all ${drawerTab === key ? "border border-[#bfdbfe] bg-white text-[#2563eb] shadow-sm" : "text-[#7c93b8] hover:text-[#3b82f6]"}`}
                        >
                          <TabIcon className="h-3 w-3 flex-shrink-0" />
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Drawer Body */}
                  <div className="flex-1 overflow-y-auto">
                    {drawerTab === "overview" && (
                      <div className="p-5 space-y-5">
                        <Card>
                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <div className="text-[0.625rem] font-bold uppercase tracking-[0.1em] text-[#94a3b8]">
                                Dernière activité
                              </div>
                              <div className="mt-1 text-2xl font-[800] tabular-nums text-[#0f172a]">
                                {daysAgoLabel(drawerItem.days_since_last_activity)}
                              </div>
                            </div>
                            <StatusPill
                              status={Number(drawerItem.overdue_balance || 0) > 0 ? "danger" : "ok"}
                              label={Number(drawerItem.overdue_balance || 0) > 0 ? "À relancer" : "À jour"}
                            />
                          </div>
                        </Card>

                        <div className="grid grid-cols-3 gap-3">
                          {[
                            { label: "Encours", value: money(drawerItem.open_balance) },
                            {
                              label: "Retard",
                              value: money(drawerItem.overdue_balance),
                              danger: Number(drawerItem.overdue_balance) > 0,
                            },
                            { label: "CA 12 mois", value: money(drawerItem.revenue_12m) },
                            {
                              label: "Délai moyen",
                              value:
                                drawerItem.average_days_to_pay != null
                                  ? `${Math.round(drawerItem.average_days_to_pay)} j`
                                  : "—",
                            },
                            {
                              label: "Impayées",
                              value: `${drawerItem.unpaid_invoice_count || 0} / ${drawerItem.invoice_count_total || 0}`,
                            },
                            {
                              label: "Retard max",
                              value: `${drawerItem.max_overdue_days || 0} j`,
                              danger: (drawerItem.max_overdue_days || 0) > 15,
                            },
                          ].map((m) => (
                            <div key={m.label} className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2.5">
                              <div className="text-[0.6rem] font-bold uppercase tracking-[0.1em] text-[#94a3b8]">
                                {m.label}
                              </div>
                              <div
                                className={`mt-1 text-sm font-[700] tabular-nums ${m.danger ? "text-[#dc2626]" : "text-[#0f172a]"}`}
                              >
                                {m.value}
                              </div>
                            </div>
                          ))}
                        </div>

                        <Card>
                          <div className="flex items-center gap-6 text-sm flex-wrap">
                            <div>
                              <span className="text-[#94a3b8]">CA total :</span>{" "}
                              <span className="font-bold text-[#0f172a]">{money(drawerItem.lifetime_revenue)}</span>
                            </div>
                            <div>
                              <span className="text-[#94a3b8]">Factures 12 mois :</span>{" "}
                              <span className="font-bold text-[#0f172a]">{drawerItem.invoice_count_12m || 0}</span>
                            </div>
                            <div>
                              <span className="text-[#94a3b8]">Paiements 12 mois :</span>{" "}
                              <span className="font-bold text-[#0f172a]">{drawerItem.payment_count_12m || 0}</span>
                            </div>
                          </div>
                        </Card>

                        {drawerItem.next_step_title && (
                          <Card>
                            <div className="flex items-start gap-2.5">
                              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#fef3c7] flex-shrink-0">
                                <Sparkles className="h-3.5 w-3.5 text-[#d97706]" />
                              </div>
                              <div>
                                <div className="text-sm font-bold text-[#92400e]">{drawerItem.next_step_title}</div>
                                {drawerItem.next_step_description && (
                                  <p className="text-xs text-[#92400e]/70 mt-0.5 leading-relaxed">
                                    {drawerItem.next_step_description}
                                  </p>
                                )}
                              </div>
                            </div>
                          </Card>
                        )}

                        {drawerTasks.length > 0 && (
                          <Card>
                            <SectionTitle>Tâches ({drawerTasks.length})</SectionTitle>
                            <div className="mt-3 space-y-2">
                              {drawerTasks.slice(0, 5).map((t: any) => (
                                <div
                                  key={t.id}
                                  className="flex items-center gap-2.5 rounded-lg bg-[#f8fafc] border border-[#f1f5f9] px-3 py-2.5"
                                >
                                  <div
                                    className={`h-2 w-2 rounded-full flex-shrink-0 ${t.status === "done" ? "bg-[#059669]" : t.priority === "high" ? "bg-[#dc2626]" : "bg-[#94a3b8]"}`}
                                  />
                                  <span className="text-sm font-medium text-[#0f172a] truncate flex-1">{t.title}</span>
                                  <StatusPill
                                    status={t.status === "done" ? "ok" : t.priority === "high" ? "danger" : "muted"}
                                    label={t.status_label || t.status}
                                  />
                                </div>
                              ))}
                            </div>
                          </Card>
                        )}

                        {drawerPeers.length > 0 && (
                          <Card>
                            <SectionTitle>Pairs du segment</SectionTitle>
                            <div className="mt-3 flex flex-wrap gap-2">
                              {drawerPeers.slice(0, 5).map((p: any) => (
                                <button
                                  key={p.customer_id}
                                  type="button"
                                  onClick={() => openDrawer(p.customer_id)}
                                  className="flex items-center gap-2 rounded-xl border border-[#e2e8f0] bg-white px-3 py-2 text-left hover:border-[#bfdbfe] hover:shadow-sm transition-all"
                                >
                                  <span className="rounded-full bg-[#eff6ff] px-2 py-1 text-[0.625rem] font-bold text-[#2563eb]">
                                    {invoiceCountLabel(Number(p.invoice_count_total || 0))}
                                  </span>
                                  <div className="min-w-0">
                                    <div className="text-xs font-bold text-[#0f172a] truncate max-w-[100px]">
                                      {p.customer_name}
                                    </div>
                                    <div className="text-[0.625rem] text-[#94a3b8] tabular-nums">
                                      {money(p.open_balance)}
                                    </div>
                                  </div>
                                </button>
                              ))}
                            </div>
                          </Card>
                        )}
                      </div>
                    )}

                    {drawerTab === "timeline" && (
                      <div className="p-5">
                        {drawerTimeline.length === 0 ? (
                          <EmptyCard
                            title="Aucun événement"
                            description="Pas encore d'historique pour ce client."
                            compact
                          />
                        ) : (
                          <div>
                            {drawerTimeline.slice(0, 20).map((event: any) => (
                              <TimelineEvent key={event.id} event={event} />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Drawer Footer */}
                  <div className="flex-shrink-0 px-6 py-4 border-t border-[#e2e8f0] bg-[#fafbfc]">
                    <Link to={drawerItem.href || `/app/customers/${drawerItem.customer_id}`} className="block w-full">
                      <PrimaryButton className="w-full justify-center">
                        Ouvrir la fiche complète <ArrowUpRight className="w-4 h-4" />
                      </PrimaryButton>
                    </Link>
                  </div>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-[#94a3b8] text-sm">
                  Client introuvable{" "}
                  <button type="button" onClick={closeDrawer} className="ml-3 text-[#1d4ed8] font-semibold">
                    Fermer
                  </button>
                </div>
              )}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
