import { useState } from "react";
import { Link, useParams } from "react-router";
import { motion } from "motion/react";
import {
  AppPageHeader,
  StatCard,
  DataTable,
  StatusPill,
  PrimaryButton,
  SecondaryButton,
  Card,
  ActionMenu,
} from "../../components/app/AppPageHeader";
import { WorkbenchPage } from "../../components/app/WorkbenchLayout";
import {
  SalesMetricCard,
  SalesMetricsGrid,
  getModuleTheme,
} from "../../../src/figma/app/components/app/SalesModuleLayout";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ArrowRight,
  Zap,
  RefreshCw,
  CreditCard,
  TrendingUp,
  TrendingDown,
  Users,
  FileText,
  Bell,
  Play,
  Pause,
  MoreHorizontal,
  Plus,
  Repeat,
  Mail,
  Send,
  BarChart3,
  Target,
  Activity,
  Calendar,
  Package,
  ChevronDown,
  ChevronRight,
  Inbox,
  Filter,
  Download,
  Upload,
  Eye,
  Search,
  ShieldCheck,
  Layers,
  Cpu,
  Radio,
  Settings2,
  Trash2,
} from "lucide-react";

/* ─── shared fade-in wrapper ─────────────────────────────── */
const FadeIn = ({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) => (
  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay }}>
    {children}
  </motion.div>
);

const SearchBar = ({
  value,
  onChange,
  placeholder,
  tint = "#2563eb",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  tint?: string;
}) => (
  <div
    className="flex items-center gap-3 rounded-2xl border bg-white px-4 py-3 shadow-[0_1px_3px_rgba(15,23,42,0.04)]"
    style={{ borderColor: `${tint}33`, boxShadow: `0 1px 3px rgba(15,23,42,0.04), 0 0 0 4px ${tint}12` }}
  >
    <Search className="h-4 w-4 flex-shrink-0" style={{ color: tint }} />
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="min-w-0 flex-1 bg-transparent text-[#334155] outline-none placeholder:text-[#94a3b8]"
      style={{ fontSize: "0.875rem", fontWeight: 500 }}
    />
  </div>
);

/* ════════════════════════════════════════════════════════════
   /app/payments — Paiements
════════════════════════════════════════════════════════════ */
export function PaymentsPage() {
  const payments = [
    {
      id: "p1",
      date: "04/03/2026",
      ref: "VIR-001",
      amount: "2 400,00",
      invoice: "FAC-2026-012",
      client: "Acme Corp",
      mode: "Virement",
      status: "matched",
    },
    {
      id: "p2",
      date: "02/03/2026",
      ref: "CB-0032",
      amount: "5 800,00",
      invoice: "FAC-2026-011",
      client: "Tech Solutions",
      mode: "CB",
      status: "matched",
    },
    {
      id: "p3",
      date: "01/03/2026",
      ref: "—",
      amount: "1 500,00",
      invoice: "?",
      client: "—",
      mode: "—",
      status: "unmatched",
    },
    {
      id: "p4",
      date: "28/02/2026",
      ref: "VIR-099",
      amount: "3 200,00",
      invoice: "FAC-2026-010",
      client: "StartupXYZ",
      mode: "Virement",
      status: "partial",
    },
  ];
  const statusMap: Record<string, { label: string; color: "ok" | "warn" | "danger" | "muted" | "info" }> = {
    matched: { label: "Paiement confirmé", color: "ok" },
    unmatched: { label: "Sans réf.", color: "danger" },
    partial: { label: "Partiel", color: "warn" },
  };
  return (
    <div>
      <AppPageHeader
        title="Paiements"
        breadcrumb="Vente"
        description="Suivi des encaissements, références et statuts de paiement."
        actions={
          <div className="flex gap-2">
            <SecondaryButton>
              <Link to="/app/cash">Trésorerie</Link>
            </SecondaryButton>
            <SecondaryButton>
              <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
            </SecondaryButton>
          </div>
        }
      />
      <div className="p-6 lg:p-8 space-y-5">
        <FadeIn>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Encaissé (30j)"
              value="13 900 €"
              sub="+12% vs mois dernier"
              accent="green"
              icon={<TrendingUp className="w-4 h-4" />}
            />
            <StatCard
              label="En attente"
              value="3 200 €"
              sub="1 facture ouverte"
              accent="amber"
              icon={<Clock className="w-4 h-4" />}
            />
            <StatCard
              label="Sans référence"
              value={1}
              sub="À rapprocher manuellement"
              accent="red"
              icon={<AlertTriangle className="w-4 h-4" />}
            />
            <StatCard
              label="Paiements partiels"
              value={1}
              sub="Solde restant dû"
              icon={<CreditCard className="w-4 h-4" />}
            />
          </div>
        </FadeIn>
        <FadeIn delay={0.1}>
          <Card>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                File d'action — Sans correspondance
              </h3>
              <span
                className="px-2 py-0.5 rounded-full bg-[#fef2f2] text-[#dc2626]"
                style={{ fontSize: "0.625rem", fontWeight: 700 }}
              >
                1 en attente
              </span>
            </div>
            <div className="flex items-center gap-3 p-3 rounded-xl bg-[#fef2f2] border border-[#fecaca]">
              <AlertTriangle className="w-4 h-4 text-[#dc2626] flex-shrink-0" />
              <div className="flex-1">
                <p className="text-[#dc2626]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                  Paiement CB-0032 du 01/03 · 1 500,00 € · sans facture associée
                </p>
              </div>
              <button
                className="px-3 py-1.5 rounded-lg bg-[#dc2626] text-white hover:bg-[#b91c1c] transition-colors"
                style={{ fontSize: "0.75rem", fontWeight: 500 }}
              >
                Rapprocher
              </button>
            </div>
          </Card>
        </FadeIn>
        <FadeIn delay={0.15}>
          <DataTable headers={["Date", "Référence", "Montant", "Facture", "Client", "Mode", "Statut"]}>
            {payments.map((p) => (
              <tr key={p.id} className="hover:bg-[#f8fafc] transition-colors">
                <td className="px-4 py-3 text-[#475569]" style={{ fontSize: "0.8125rem" }}>
                  {p.date}
                </td>
                <td className="px-4 py-3 font-mono text-[#374151]" style={{ fontSize: "0.75rem" }}>
                  {p.ref}
                </td>
                <td className="px-4 py-3 text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                  {p.amount} €
                </td>
                <td className="px-4 py-3 text-[#1d4ed8]" style={{ fontSize: "0.8125rem" }}>
                  {p.invoice}
                </td>
                <td className="px-4 py-3 text-[#475569]" style={{ fontSize: "0.8125rem" }}>
                  {p.client}
                </td>
                <td className="px-4 py-3 text-[#475569]" style={{ fontSize: "0.8125rem" }}>
                  {p.mode}
                </td>
                <td className="px-4 py-3">
                  <StatusPill {...statusMap[p.status]} />
                </td>
              </tr>
            ))}
          </DataTable>
        </FadeIn>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   /app/purchases — Achats & fournisseurs
════════════════════════════════════════════════════════════ */
export function PurchasesPage() {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const purchaseTheme = getModuleTheme("purchases");
  const purchases = [
    {
      id: "pu1",
      supplier: "Hébergeur de l'instance",
      date: "28/02/2026",
      amount: "312,00",
      workflow: "à valider",
      next: "Bon à payer",
      status: "pending",
    },
    {
      id: "pu2",
      supplier: "Docaposte PDP",
      date: "25/02/2026",
      amount: "890,00",
      workflow: "validé",
      next: "Archiver",
      status: "done",
    },
    {
      id: "pu3",
      supplier: "Stripe Inc.",
      date: "20/02/2026",
      amount: "145,50",
      workflow: "pièce manquante",
      next: "Demander pièce",
      status: "warn",
    },
    {
      id: "pu4",
      supplier: "Figma Inc.",
      date: "15/02/2026",
      amount: "75,00",
      workflow: "bon à payer",
      next: "Payer",
      status: "ready",
    },
  ];
  const wfColor: Record<string, "ok" | "warn" | "danger" | "muted" | "info"> = {
    pending: "warn",
    done: "ok",
    warn: "danger",
    ready: "info",
  };
  const filterLabel =
    filter === "pending"
      ? "À valider"
      : filter === "done"
        ? "Validés"
        : filter === "warn"
          ? "Pièce manquante"
          : filter === "ready"
            ? "Bons à payer"
            : "Tous";
  const pendingCount = purchases.filter((purchase) => purchase.status === "pending").length;
  const doneCount = purchases.filter((purchase) => purchase.status === "done").length;
  const warnCount = purchases.filter((purchase) => purchase.status === "warn").length;
  const readyCount = purchases.filter((purchase) => purchase.status === "ready").length;
  const totalAmount = purchases.reduce((sum, purchase) => sum + Number(String(purchase.amount).replace(",", ".")), 0);
  const filteredPurchases = purchases.filter((purchase) => {
    if (filter !== "all" && purchase.status !== filter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [purchase.supplier, purchase.workflow, purchase.next, purchase.amount].join(" ").toLowerCase().includes(q);
  });
  const purchaseTabs = [
    { value: "all", label: "Tous", count: purchases.length },
    { value: "pending", label: "À valider", count: pendingCount },
    { value: "done", label: "Validés", count: doneCount },
    { value: "warn", label: "Pièce manquante", count: warnCount },
    { value: "ready", label: "Bons à payer", count: readyCount },
  ];
  return (
    <div>
      <AppPageHeader
        title="Achats & fournisseurs"
        breadcrumb="Exploitation"
        description="Votre boîte de réception fournisseur — simple et exploitable."
        actions={
          <div className="flex gap-2">
            <ActionMenu
              label="Filtres"
              items={[
                { label: "Tous", icon: Filter, onClick: () => setFilter("all") },
                { label: "À valider", icon: Clock, onClick: () => setFilter("pending") },
                { label: "Validés", icon: CheckCircle2, onClick: () => setFilter("done") },
                { label: "Pièce manquante", icon: AlertTriangle, onClick: () => setFilter("warn") },
                { label: "Bons à payer", icon: CreditCard, onClick: () => setFilter("ready") },
              ]}
            />
          </div>
        }
      />
      <WorkbenchPage>
        <FadeIn delay={0.1}>
          <div className="space-y-4">
            <SalesMetricsGrid>
              <SalesMetricCard
                tone="purchases"
                density="client"
                label="Documents reçus"
                value={purchases.length}
                detail="Base fournisseur visible"
                icon={<Inbox className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="purchases"
                density="client"
                accent="warning"
                label="À valider"
                value={pendingCount}
                detail="Action requise"
                icon={<Clock className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="purchases"
                density="client"
                accent="info"
                label="Bon à payer"
                value={readyCount}
                detail={`${doneCount} déjà validé(s)`}
                icon={<CreditCard className="h-4 w-4" />}
              />
              <SalesMetricCard
                tone="purchases"
                density="client"
                accent="danger"
                label="À corriger"
                value={warnCount}
                detail={`${totalAmount.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} € suivis`}
                icon={<AlertTriangle className="h-4 w-4" />}
              />
            </SalesMetricsGrid>

            <div
              className="overflow-hidden rounded-2xl bg-white"
              style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)" }}
            >
              <div
                className="flex flex-col justify-between gap-3 px-4 py-3 sm:flex-row sm:items-center"
                style={{ borderBottom: "1px solid #f1f5f9" }}
              >
                <div className="flex items-center gap-0.5">
                  {purchaseTabs.map((item) => {
                    const active = filter === item.value;
                    return (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => setFilter(item.value)}
                        className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition-all"
                        style={{
                          fontSize: "0.8125rem",
                          fontWeight: active ? 600 : 400,
                          background: active ? purchaseTheme.gradient : "transparent",
                          color: active ? "#ffffff" : "#64748b",
                          boxShadow: active ? "0 1px 4px rgba(8,145,178,0.18)" : "none",
                        }}
                      >
                        {item.label}
                        <span
                          className="inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full px-1.5"
                          style={{
                            fontSize: "0.625rem",
                            fontWeight: 700,
                            background: active ? "rgba(255,255,255,0.22)" : "#f1f5f9",
                            color: active ? "#ffffff" : "#94a3b8",
                          }}
                        >
                          {item.count}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div
                  className="flex items-center gap-2 rounded-lg px-3 py-1.5 sm:w-64"
                  style={{ background: "#f8fafc", border: "1px solid #e9eef4" }}
                >
                  <Search className="h-3.5 w-3.5 flex-shrink-0 text-[#94a3b8]" />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Fournisseur, workflow..."
                    className="min-w-0 flex-1 bg-transparent text-[#374151] outline-none placeholder:text-[#94a3b8]"
                    style={{ fontSize: "0.8125rem" }}
                  />
                </div>
              </div>

              {filteredPurchases.length === 0 ? (
                <div className="px-5 py-14 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-2xl bg-[#f4f6fa]">
                      <Inbox className="h-5 w-5 text-[#cbd5e1]" />
                    </div>
                    <p className="text-[#64748b]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                      Aucun document fournisseur
                    </p>
                    <p className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                      {search ? `"${search}" ne correspond à aucun achat` : "Aucun document pour ce filtre"}
                    </p>
                    {filter !== "all" || search ? (
                      <button
                        type="button"
                        onClick={() => {
                          setSearch("");
                          setFilter("all");
                        }}
                        className="mt-1 text-[#0e7490] transition-colors hover:text-[#155e75]"
                        style={{ fontSize: "0.8125rem", fontWeight: 500 }}
                      >
                        Voir tous les achats
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="pf-data-table w-full">
                    <thead>
                      <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                        {["Fournisseur", "Réception", "Montant", "Workflow", "Prochaine étape", ""].map(
                          (header, index) => (
                            <th
                              key={`${header || "action"}-${index}`}
                              className="px-3 py-2 text-left"
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
                      {filteredPurchases.map((p) => (
                        <tr key={p.id} className="transition-colors hover:bg-[#f5fcfe]">
                          <td className="px-3 py-2.5">
                            <Link
                              to={`/app/purchases/${p.id}`}
                              className="transition-colors hover:opacity-80"
                              style={{ color: purchaseTheme.strong, fontSize: "0.875rem", fontWeight: 700 }}
                            >
                              {p.supplier}
                            </Link>
                          </td>
                          <td className="px-3 py-2.5 text-[#475569]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                            {p.date}
                          </td>
                          <td className="px-3 py-2.5 text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 800 }}>
                            {p.amount} €
                          </td>
                          <td className="px-3 py-2.5">
                            <StatusPill label={p.workflow} color={wfColor[p.status]} />
                          </td>
                          <td className="px-3 py-2.5 text-[#475569]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                            {p.next}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <Link
                              to={`/app/purchases/${p.id}`}
                              className="pf-action-icon"
                              aria-label={`Ouvrir ${p.supplier}`}
                              title="Ouvrir"
                            >
                              <ArrowRight className="h-3.5 w-3.5" />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div
                className="flex items-center justify-between px-4 py-2.5"
                style={{ borderTop: "1px solid #f1f5f9", background: "#fafbfd" }}
              >
                <span className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                  {filteredPurchases.length} achat{filteredPurchases.length > 1 ? "s" : ""}
                  {filter !== "all" ? <span className="ml-1">· filtre actif</span> : null}
                </span>
                {filter !== "all" || search ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setFilter("all");
                    }}
                    className="text-[#0e7490] transition-colors hover:text-[#155e75]"
                    style={{ fontSize: "0.75rem", fontWeight: 500 }}
                  >
                    Réinitialiser
                  </button>
                ) : (
                  <span className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                    Filtre · {filterLabel}
                  </span>
                )}
              </div>
            </div>
          </div>
        </FadeIn>
      </WorkbenchPage>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   /app/purchases/:id — Détail achat fournisseur
════════════════════════════════════════════════════════════ */
export function PurchaseDetailPage() {
  const { id } = useParams();
  const [step, setStep] = useState("Valider");
  return (
    <div>
      <AppPageHeader
        title="Hébergeur de l'instance · Facture fournisseur"
        breadcrumb="Achats · Détail"
        backHref="/app/purchases"
        actions={
          <div className="flex gap-2">
            <SecondaryButton>
              <CheckCircle2 className="w-3.5 h-3.5" /> Accepter
            </SecondaryButton>
            <PrimaryButton>Enregistrer le workflow</PrimaryButton>
          </div>
        }
      />
      <div className="p-6 lg:p-8 space-y-5">
        <div className="grid md:grid-cols-3 gap-4">
          <StatCard label="Montant TTC" value="312,00 €" accent="blue" />
          <StatCard label="TVA" value="52,00 €" sub="20% sur 260,00 €" />
          <StatCard label="Échéance" value="28/03/2026" sub="À venir" accent="amber" />
        </div>
        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <h3 className="text-[#0f172a] mb-4" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
              Fournisseur
            </h3>
            {[
              ["Raison sociale", "Hébergeur de l'instance SAS"],
              ["SIRET", "424 761 419 00045"],
              ["N° TVA", "FR 22 424761419"],
              ["E-mail", "factures@ovhcloud.com"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between py-1.5 border-b border-[#f8fafc] last:border-0">
                <span className="text-[#94a3b8]" style={{ fontSize: "0.8125rem" }}>
                  {k}
                </span>
                <span className="text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                  {v}
                </span>
              </div>
            ))}
          </Card>
          <Card>
            <h3 className="text-[#0f172a] mb-4" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
              Workflow interne
            </h3>
            <div className="space-y-3">
              {["Réception", "Validation", "Bon à payer", "Archivé"].map((s, i) => (
                <div key={s} className="flex items-center gap-3">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${i < 1 ? "bg-[#059669]" : i === 1 ? "bg-[#1d4ed8]" : "bg-[#f1f5f9]"}`}
                  >
                    {i < 1 ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                    ) : (
                      <span style={{ fontSize: "0.625rem", fontWeight: 700, color: i === 1 ? "white" : "#94a3b8" }}>
                        {i + 1}
                      </span>
                    )}
                  </div>
                  <span
                    style={{
                      fontSize: "0.8125rem",
                      color: i < 2 ? "#0f172a" : "#94a3b8",
                      fontWeight: i === 1 ? 600 : 400,
                    }}
                  >
                    {s}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-[#f1f5f9]">
              <label className="block text-[#374151] mb-1.5" style={{ fontSize: "0.75rem", fontWeight: 500 }}>
                Note opérateur
              </label>
              <textarea
                rows={2}
                placeholder="Commentaire interne…"
                className="w-full px-3 py-2 border border-[#e2e8f0] rounded-lg text-[#374151] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all resize-none"
                style={{ fontSize: "0.8125rem" }}
              />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   /app/cash — Trésorerie & paiements
════════════════════════════════════════════════════════════ */
export function CashPage() {
  const recentPayments = [
    { date: "04/03/2026", client: "Acme Corp", amount: "2 400,00", mode: "Virement" },
    { date: "02/03/2026", client: "Tech Solutions", amount: "5 800,00", mode: "CB" },
    { date: "28/02/2026", client: "Global Services", amount: "1 500,00", mode: "Chèque" },
  ];
  return (
    <div>
      <AppPageHeader
        title="Trésorerie & paiements"
        breadcrumb="Exploitation"
        description="KPIs cash, dossiers prioritaires et tensions d'encours."
        actions={
          <div className="flex gap-2">
            <SecondaryButton>
              <Link to="/app/invoices?status=overdue">Factures en retard</Link>
            </SecondaryButton>
            <SecondaryButton>
              <RefreshCw className="w-3.5 h-3.5" />
            </SecondaryButton>
          </div>
        }
      />
      <div className="p-6 lg:p-8 space-y-5">
        <FadeIn>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Encaissé (30j)"
              value="9 700 €"
              sub="+8% vs M-1"
              accent="green"
              icon={<TrendingUp className="w-4 h-4" />}
            />
            <StatCard
              label="DSO moyen"
              value="28 jours"
              sub="Délai de paiement"
              accent="amber"
              icon={<Clock className="w-4 h-4" />}
            />
            <StatCard
              label="Taux de collecte"
              value="94,2 %"
              sub="Sur 90 jours glissants"
              accent="blue"
              icon={<Target className="w-4 h-4" />}
            />
            <StatCard
              label="Tensions encours"
              value="3 200 €"
              sub="1 compte à risque"
              accent="red"
              icon={<TrendingDown className="w-4 h-4" />}
            />
          </div>
        </FadeIn>
        <FadeIn delay={0.1}>
          <div className="grid md:grid-cols-2 gap-6">
            <Card>
              <h3 className="text-[#0f172a] mb-4" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                Paiements récents
              </h3>
              <div className="space-y-2">
                {recentPayments.map((p, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between py-2 border-b border-[#f8fafc] last:border-0"
                  >
                    <div>
                      <p className="text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                        {p.client}
                      </p>
                      <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                        {p.date} · {p.mode}
                      </p>
                    </div>
                    <span className="text-[#059669]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                      + {p.amount} €
                    </span>
                  </div>
                ))}
              </div>
            </Card>
            <Card>
              <h3 className="text-[#0f172a] mb-4" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                Dossiers prioritaires
              </h3>
              <div className="space-y-2">
                <div className="flex items-center gap-3 p-3 rounded-xl bg-[#fef2f2] border border-[#fecaca]">
                  <AlertTriangle className="w-4 h-4 text-[#dc2626] flex-shrink-0" />
                  <div>
                    <p className="text-[#dc2626]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                      StartupXYZ — 3 200 € en retard
                    </p>
                    <p className="text-[#f87171]" style={{ fontSize: "0.75rem" }}>
                      Échéance dépassée de 17 jours
                    </p>
                  </div>
                  <Link to="/app/invoices?status=overdue" className="ml-auto text-[#dc2626] hover:text-[#b91c1c]">
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
                <div className="flex items-center gap-3 p-3 rounded-xl bg-[#fffbeb] border border-[#fef08a]">
                  <Clock className="w-4 h-4 text-[#d97706] flex-shrink-0" />
                  <div>
                    <p className="text-[#92400e]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                      Digital Agency — 4 200 € brouillon
                    </p>
                    <p className="text-[#b45309]" style={{ fontSize: "0.75rem" }}>
                      À émettre avant le 15/03
                    </p>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </FadeIn>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   /app/portfolio — Portefeuille client
════════════════════════════════════════════════════════════ */
export function PortfolioPage() {
  const [selected, setSelected] = useState<string[]>([]);
  const accounts = [
    { id: "c1", name: "Acme Corp", segment: "Compte clé", encours: "4 200 €", risk: "low", status: "ok" },
    { id: "c2", name: "Tech Solutions", segment: "Stable", encours: "5 800 €", risk: "low", status: "ok" },
    { id: "c3", name: "StartupXYZ", segment: "À risque", encours: "3 200 €", risk: "high", status: "danger" },
    { id: "c4", name: "Global Services", segment: "Dormant", encours: "0 €", risk: "medium", status: "warn" },
    { id: "c5", name: "Digital Agency", segment: "Nouveau", encours: "4 200 €", risk: "medium", status: "info" },
  ];
  const segCounts = {
    "Compte clé": 1,
    "À risque": 1,
    Watchlist: 0,
    Nouveau: 1,
    Dormant: 1,
    Stable: 1,
  };
  const riskColor: Record<string, "ok" | "danger" | "warn" | "info" | "muted"> = {
    low: "ok",
    high: "danger",
    medium: "warn",
  };
  const segmentTone: Record<string, { bar: string; bg: string; text: string }> = {
    "Compte clé": { bar: "#7c3aed", bg: "#f5f3ff", text: "#6d28d9" },
    "À risque": { bar: "#ef4444", bg: "#fef2f2", text: "#dc2626" },
    Watchlist: { bar: "#f59e0b", bg: "#fffbeb", text: "#d97706" },
    Nouveau: { bar: "#2563eb", bg: "#eff6ff", text: "#1d4ed8" },
    Dormant: { bar: "#64748b", bg: "#f8fafc", text: "#475569" },
    Stable: { bar: "#16a34a", bg: "#f0fdf4", text: "#15803d" },
  };

  return (
    <div>
      <AppPageHeader
        title="Portefeuille client"
        breadcrumb="Pilotage"
        description="Segmentation, sélection et actions groupées sur vos comptes."
        actions={
          <div className="flex gap-2">
            <SecondaryButton>Créer la campagne</SecondaryButton>
            <PrimaryButton>Créer les tâches</PrimaryButton>
          </div>
        }
      />
      <div className="p-6 lg:p-8 space-y-5">
        <FadeIn>
          <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
            {Object.entries(segCounts).map(([seg, count]) => {
              const tone = segmentTone[seg] || segmentTone.Stable;
              return (
                <div
                  key={seg}
                  className="text-center p-3 rounded-xl bg-white border border-[#e2e8f0] shadow-[0_1px_3px_rgba(0,0,0,0.05)]"
                  style={{ boxShadow: `inset 0 3px 0 ${tone.bar}, 0 1px 3px rgba(0,0,0,0.05)` }}
                >
                  <div className="text-[#0f172a]" style={{ fontSize: "1.25rem", fontWeight: 700 }}>
                    {count}
                  </div>
                  <div style={{ color: tone.text, fontSize: "0.6875rem", fontWeight: 700 }}>{seg}</div>
                </div>
              );
            })}
          </div>
        </FadeIn>
        <FadeIn delay={0.1}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[#64748b]" style={{ fontSize: "0.75rem" }}>
              Sélection rapide :
            </span>
            {["Visible", "À risque visibles", "Avec retard", "Effacer"].map((f) => (
              <button
                key={f}
                className="px-3 py-1.5 rounded-lg border border-[#e2e8f0] bg-white text-[#475569] hover:bg-[#f8fafc] transition-colors"
                style={{ fontSize: "0.75rem" }}
              >
                {f}
              </button>
            ))}
            {selected.length > 0 && (
              <span
                className="ml-2 px-2 py-0.5 rounded-full bg-[#1d4ed8] text-white"
                style={{ fontSize: "0.625rem", fontWeight: 700 }}
              >
                {selected.length} sélectionné(s)
              </span>
            )}
          </div>
        </FadeIn>
        <FadeIn delay={0.15}>
          <DataTable headers={["", "Client", "Segment", "Encours", "Risque"]}>
            {accounts.map((a) => (
              <tr key={a.id} className="hover:bg-[#f8fafc] transition-colors">
                <td className="px-4 py-3 w-8">
                  <input
                    type="checkbox"
                    checked={selected.includes(a.id)}
                    onChange={(e) =>
                      setSelected((prev) => (e.target.checked ? [...prev, a.id] : prev.filter((x) => x !== a.id)))
                    }
                    className="rounded"
                  />
                </td>
                <td className="px-4 py-3">
                  <Link
                    to={`/app/customers/${a.id}`}
                    className="text-[#1d4ed8] hover:text-[#1e40af]"
                    style={{ fontSize: "0.8125rem", fontWeight: 600 }}
                  >
                    {a.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-[#475569]" style={{ fontSize: "0.8125rem" }}>
                  {a.segment}
                </td>
                <td className="px-4 py-3 text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                  {a.encours}
                </td>
                <td className="px-4 py-3">
                  <StatusPill
                    label={a.segment === "À risque" ? "À risque" : a.segment === "Stable" ? "Stable" : "Surveillance"}
                    color={riskColor[a.risk]}
                  />
                </td>
              </tr>
            ))}
          </DataTable>
        </FadeIn>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   /app/recurring — Abonnements & récurrence
════════════════════════════════════════════════════════════ */
export function RecurringPage() {
  const plans = [
    {
      id: "r1",
      name: "Abonnement SaaS mensuel",
      client: "Tech Solutions",
      amount: "1 200,00",
      period: "Mensuel",
      next: "01/04/2026",
      status: "active",
    },
    {
      id: "r2",
      name: "Maintenance annuelle",
      client: "Acme Corp",
      amount: "2 400,00",
      period: "Annuel",
      next: "01/06/2026",
      status: "active",
    },
    {
      id: "r3",
      name: "Support premium",
      client: "Global Services",
      amount: "300,00",
      period: "Mensuel",
      next: "—",
      status: "paused",
    },
  ];
  const statusMap: Record<string, { label: string; color: "ok" | "warn" | "muted" }> = {
    active: { label: "Actif", color: "ok" },
    paused: { label: "Suspendu", color: "muted" },
  };
  return (
    <div>
      <AppPageHeader
        title="Abonnements & récurrence"
        breadcrumb="Pilotage"
        description="Plans récurrents et exécution automatique de vos factures périodiques."
        actions={
          <div className="flex gap-2">
            <SecondaryButton>
              <RefreshCw className="w-3.5 h-3.5" /> Exécuter les dues
            </SecondaryButton>
            <PrimaryButton>
              <Plus className="w-3.5 h-3.5" /> Créer le plan
            </PrimaryButton>
          </div>
        }
      />
      <div className="p-6 lg:p-8 space-y-5">
        <FadeIn>
          <div className="grid grid-cols-3 gap-4">
            <StatCard
              label="Plans actifs"
              value={2}
              sub="Générés automatiquement"
              accent="green"
              icon={<Repeat className="w-4 h-4" />}
            />
            <StatCard
              label="Prochain run"
              value="01/04/2026"
              sub="2 factures à générer"
              icon={<Calendar className="w-4 h-4" />}
            />
            <StatCard
              label="Revenu récurrent"
              value="3 600 €/mois"
              sub="MRR estimé"
              accent="blue"
              icon={<TrendingUp className="w-4 h-4" />}
            />
          </div>
        </FadeIn>
        <FadeIn delay={0.1}>
          <DataTable headers={["Plan", "Client", "Montant", "Périodicité", "Prochain run", "Statut", ""]}>
            {plans.map((p) => (
              <tr key={p.id} className="hover:bg-[#f8fafc] transition-colors">
                <td className="px-4 py-3 text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                  {p.name}
                </td>
                <td className="px-4 py-3 text-[#475569]" style={{ fontSize: "0.8125rem" }}>
                  {p.client}
                </td>
                <td className="px-4 py-3 text-[#0f172a]" style={{ fontSize: "0.875rem", fontWeight: 700 }}>
                  {p.amount} €
                </td>
                <td className="px-4 py-3 text-[#475569]" style={{ fontSize: "0.8125rem" }}>
                  {p.period}
                </td>
                <td className="px-4 py-3 text-[#475569]" style={{ fontSize: "0.8125rem" }}>
                  {p.next}
                </td>
                <td className="px-4 py-3">
                  <StatusPill {...statusMap[p.status]} />
                </td>
                <td className="px-4 py-3 flex gap-1">
                  {p.status === "active" ? (
                    <button className="p-1 rounded hover:bg-[#f8fafc]">
                      <Pause className="w-3.5 h-3.5 text-[#94a3b8]" />
                    </button>
                  ) : (
                    <button className="p-1 rounded hover:bg-[#f8fafc]">
                      <Play className="w-3.5 h-3.5 text-[#94a3b8]" />
                    </button>
                  )}
                  <Link
                    to="/app/invoices"
                    className="p-1 rounded hover:bg-[#f8fafc] text-[#94a3b8] hover:text-[#1d4ed8]"
                  >
                    <FileText className="w-3.5 h-3.5" />
                  </Link>
                </td>
              </tr>
            ))}
          </DataTable>
        </FadeIn>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   /app/tasks — Tâches d'équipe
════════════════════════════════════════════════════════════ */
export function TasksPage() {
  const [newTask, setNewTask] = useState("");
  const tasks = [
    {
      id: "t1",
      title: "Relancer StartupXYZ",
      assignee: "Marie D.",
      due: "07/03/2026",
      status: "open",
      priority: "high",
    },
    {
      id: "t2",
      title: "Valider facture fournisseur OVH",
      assignee: "Jean M.",
      due: "10/03/2026",
      status: "open",
      priority: "medium",
    },
    {
      id: "t3",
      title: "Mettre à jour IBAN entreprise",
      assignee: "Admin D.",
      due: "05/03/2026",
      status: "done",
      priority: "high",
    },
    {
      id: "t4",
      title: "Préparer export DGFiP Q1",
      assignee: "Marie D.",
      due: "31/03/2026",
      status: "open",
      priority: "low",
    },
  ];
  const prioColor: Record<string, string> = { high: "#ef4444", medium: "#f59e0b", low: "#94a3b8" };
  const byStatus = (s: string) => tasks.filter((t) => t.status === s);

  const KanbanCol = ({ title, items, color }: { title: string; items: typeof tasks; color: string }) => (
    <div className="flex-1 min-w-[200px]">
      <div className="flex items-center gap-2 mb-3">
        <span className={`w-2 h-2 rounded-full`} style={{ background: color }} />
        <span className="text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
          {title}
        </span>
        <span className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
          ({items.length})
        </span>
      </div>
      <div className="space-y-2">
        {items.map((t) => (
          <div
            key={t.id}
            className="bg-white rounded-xl border border-[#e2e8f0] p-3 shadow-[0_1px_3px_rgba(0,0,0,0.04)] hover:shadow-[0_2px_8px_rgba(0,0,0,0.08)] transition-shadow"
          >
            <p className="text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
              {t.title}
            </p>
            <div className="flex items-center gap-2 mt-2">
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: prioColor[t.priority] }} />
              <span className="text-[#94a3b8]" style={{ fontSize: "0.6875rem" }}>
                {t.assignee} · {t.due}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div>
      <AppPageHeader
        title="Tâches d'équipe"
        breadcrumb="Pilotage"
        description="Board des tâches opérateurs et suivi des actions en cours."
        actions={
          <div className="flex gap-2">
            <SecondaryButton>
              <RefreshCw className="w-3.5 h-3.5" />
            </SecondaryButton>
            <PrimaryButton>
              <Plus className="w-3.5 h-3.5" /> Créer la tâche
            </PrimaryButton>
          </div>
        }
      />
      <div className="p-6 lg:p-8 space-y-6">
        <FadeIn>
          <div className="grid grid-cols-3 gap-4">
            <StatCard
              label="À faire"
              value={byStatus("open").length}
              sub="Files en attente"
              accent="amber"
              icon={<Clock className="w-4 h-4" />}
            />
            <StatCard
              label="En cours"
              value={2}
              sub="Exécution opérateur"
              accent="blue"
              icon={<Activity className="w-4 h-4" />}
            />
            <StatCard
              label="Terminées"
              value={byStatus("done").length}
              sub="Clôturées"
              accent="green"
              icon={<CheckCircle2 className="w-4 h-4" />}
            />
          </div>
        </FadeIn>
        <FadeIn delay={0.05}>
          <Card>
            <h3 className="text-[#0f172a] mb-3" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
              Nouvelle tâche
            </h3>
            <div className="flex gap-3">
              <input
                value={newTask}
                onChange={(e) => setNewTask(e.target.value)}
                placeholder="Titre de la tâche…"
                className="flex-1 px-3.5 py-2.5 border border-[#e2e8f0] rounded-xl text-[#0f172a] placeholder:text-[#94a3b8] focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/20 focus:border-[#1d4ed8] transition-all shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
                style={{ fontSize: "0.8125rem" }}
              />
              <button
                onClick={() => setNewTask("")}
                className="px-4 py-2.5 rounded-xl text-white transition-all"
                style={{
                  background: "linear-gradient(135deg,#1d4ed8,#4f46e5)",
                  fontSize: "0.8125rem",
                  fontWeight: 500,
                }}
              >
                Créer
              </button>
            </div>
          </Card>
        </FadeIn>
        <FadeIn delay={0.1}>
          <div className="flex gap-4 overflow-x-auto pb-2">
            <KanbanCol title="À faire" items={byStatus("open").slice(0, 2)} color="#f59e0b" />
            <KanbanCol title="En cours" items={byStatus("open").slice(2)} color="#1d4ed8" />
            <KanbanCol title="Terminé" items={byStatus("done")} color="#059669" />
          </div>
        </FadeIn>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   /app/notifications
════════════════════════════════════════════════════════════ */
export function NotificationsPage() {
  const [tab, setTab] = useState("all");
  const [showSla, setShowSla] = useState(false);
  const allAlerts = [
    {
      id: "n1",
      title: "Une facture est en retard de paiement",
      level: "critical",
      time: "Il y a 2h",
      read: false,
      href: "/app/invoices",
    },
    {
      id: "n2",
      title: "Un devis est en attente depuis 7 jours",
      level: "high",
      time: "Il y a 4h",
      read: false,
      href: "/app/quotes",
    },
    { id: "n3", title: "Digest quotidien généré", level: "info", time: "Ce matin", read: true, href: "#" },
    {
      id: "n4",
      title: "Facture fournisseur reçue",
      level: "info",
      time: "Hier 17:30",
      read: true,
      href: "/app/purchases",
    },
  ];
  const dots: Record<string, string> = { critical: "#ef4444", high: "#f59e0b", info: "#1d4ed8" };
  const unread = allAlerts.filter((a) => !a.read).length;
  const criticalCount = allAlerts.filter((a) => a.level === "critical").length;
  const infoCount = allAlerts.filter((a) => a.level === "info").length;
  const filtered =
    tab === "all"
      ? allAlerts
      : tab === "unread"
        ? allAlerts.filter((a) => !a.read)
        : allAlerts.filter((a) => a.level !== "info");

  return (
    <div>
      <AppPageHeader
        title="Notifications, digest & SLA"
        breadcrumb="Pilotage"
        description="Alertes, digest automatiques et règles de suivi SLA."
        actions={
          <SecondaryButton onClick={() => {}}>
            Tout marquer lu{" "}
            {unread > 0 && (
              <span
                className="ml-1 px-1.5 py-0.5 rounded-full bg-[#f1f5f9] text-[#64748b]"
                style={{ fontSize: "0.5625rem", fontWeight: 700 }}
              >
                {unread}
              </span>
            )}
          </SecondaryButton>
        }
      />
      <div className="p-6 lg:p-8 space-y-5 max-w-2xl">
        <div className="grid grid-cols-3 gap-4">
          <StatCard
            label="Non lues"
            value={unread}
            sub="À lire maintenant"
            accent="purple"
            icon={<Bell className="w-4 h-4" />}
          />
          <StatCard
            label="Critiques"
            value={criticalCount}
            sub="Factures ou relances sensibles"
            accent="red"
            icon={<AlertTriangle className="w-4 h-4" />}
          />
          <StatCard
            label="Info & digest"
            value={infoCount}
            sub="Messages de service"
            accent="blue"
            icon={<Mail className="w-4 h-4" />}
          />
        </div>

        <div className="flex gap-1 bg-[#f4f6fa] rounded-xl p-1 w-fit">
          {[
            ["all", "Toutes"],
            ["unread", "Non lues"],
            ["critical", "Critiques"],
          ].map(([v, l]) => (
            <button
              key={v}
              onClick={() => setTab(v)}
              className={`px-3 py-1.5 rounded-lg transition-all ${tab === v ? "bg-white shadow-sm" : "text-[#64748b] hover:text-[#374151]"}`}
              style={{
                fontSize: "0.8125rem",
                fontWeight: tab === v ? 700 : 400,
                color: tab === v ? "#6d28d9" : undefined,
              }}
            >
              {l}
            </button>
          ))}
        </div>

        <Card padding={false}>
          {filtered.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-[#94a3b8]" style={{ fontSize: "0.875rem" }}>
                Aucune notification pour ce filtre.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[#f8fafc]">
              {filtered.map((a) => (
                <Link
                  key={a.id}
                  to={(a as any).href || "#"}
                  className={`flex items-start gap-3 px-5 py-4 hover:bg-[#f8fafc] transition-colors ${a.read ? "opacity-60" : ""}`}
                >
                  <span className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0" style={{ background: dots[a.level] }} />
                  <div className="flex-1 min-w-0">
                    <p style={{ fontSize: "0.8125rem", fontWeight: a.read ? 400 : 600, color: "#374151" }}>{a.title}</p>
                    <p className="text-[#94a3b8] mt-0.5" style={{ fontSize: "0.75rem" }}>
                      {a.time}
                    </p>
                  </div>
                  {!a.read && <span className="w-2 h-2 rounded-full bg-[#1d4ed8] mt-1.5 flex-shrink-0" />}
                </Link>
              ))}
            </div>
          )}
        </Card>

        <div className="bg-white rounded-2xl overflow-hidden" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <button
            onClick={() => setShowSla((o) => !o)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#f8fafc] transition-colors"
          >
            <span className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
              Règles SLA
            </span>
            <ChevronDown className={`w-4 h-4 text-[#94a3b8] transition-transform ${showSla ? "rotate-180" : ""}`} />
          </button>
          {showSla && (
            <div className="border-t border-[#f8fafc] px-5 pb-4 space-y-3 pt-3">
              {[
                ["Facture non payée > 15j", "Alerte critique", "ok"],
                ["Devis sans réponse > 7j", "Alerte haute", "ok"],
                ["Facture non émise > 5j", "Relance équipe", "warn"],
              ].map(([rule, action, s]) => (
                <div key={rule} className="flex items-center justify-between py-1.5">
                  <div>
                    <p className="text-[#374151]" style={{ fontSize: "0.8125rem" }}>
                      {rule}
                    </p>
                    <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                      → {action}
                    </p>
                  </div>
                  <StatusPill label={s === "ok" ? "Actif" : "Brouillon"} color={s === "ok" ? "ok" : "warn"} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   /app/automations
════════════════════════════════════════════════════════════ */
export function AutomationsPage() {
  const [showTemplates, setShowTemplates] = useState(false);
  const playbooks = [
    { id: "a1", name: "Relance J+15", trigger: "Facture non payée 15j", active: true },
    { id: "a2", name: "Confirmation paiement", trigger: "Paiement enregistré", active: true },
    { id: "a3", name: "Alerte achat non validé", trigger: "Achat reçu non validé 5j", active: false },
  ];
  return (
    <div>
      <AppPageHeader
        title="Automatisations"
        breadcrumb="Pilotage"
        description="Playbooks métier actifs sur votre compte."
        actions={
          <PrimaryButton>
            <Plus className="w-3.5 h-3.5" /> Créer un playbook
          </PrimaryButton>
        }
      />
      <div className="p-6 lg:p-8 space-y-5 max-w-2xl">
        <Card>
          <div className="divide-y divide-[#f8fafc]">
            {playbooks.map((p) => (
              <div key={p.id} className="flex items-center gap-4 py-3.5 first:pt-0 last:pb-0">
                <div
                  className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${p.active ? "bg-[#eff6ff]" : "bg-[#f1f5f9]"}`}
                >
                  <Zap className={`w-4 h-4 ${p.active ? "text-[#1d4ed8]" : "text-[#94a3b8]"}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                    {p.name}
                  </p>
                  <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                    {p.trigger}
                  </p>
                </div>
                <StatusPill label={p.active ? "Actif" : "Inactif"} color={p.active ? "ok" : "muted"} />
                <button
                  className="text-[#64748b] hover:text-[#374151] transition-colors flex-shrink-0"
                  style={{ fontSize: "0.75rem" }}
                >
                  Modifier
                </button>
              </div>
            ))}
          </div>
        </Card>

        <div className="bg-white rounded-2xl overflow-hidden" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <button
            onClick={() => setShowTemplates((o) => !o)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#f8fafc] transition-colors"
          >
            <span className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
              Templates disponibles
            </span>
            <ChevronDown
              className={`w-4 h-4 text-[#94a3b8] transition-transform ${showTemplates ? "rotate-180" : ""}`}
            />
          </button>
          {showTemplates && (
            <div className="border-t border-[#f8fafc] px-5 pb-4 pt-3 grid grid-cols-2 gap-2">
              {["Relance escalade J+30", "Rapport mensuel auto", "Alerte DSO critique", "Onboarding client"].map(
                (t) => (
                  <div key={t} className="flex items-center justify-between p-3 rounded-xl bg-[#f8fafc]">
                    <span className="text-[#475569] truncate" style={{ fontSize: "0.8125rem" }}>
                      {t}
                    </span>
                    <button
                      className="text-[#1d4ed8] ml-2 flex-shrink-0"
                      style={{ fontSize: "0.75rem", fontWeight: 600 }}
                    >
                      Activer
                    </button>
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   /app/campaigns
════════════════════════════════════════════════════════════ */
export function CampaignsPage() {
  const [search, setSearch] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("tpl-fiabilisation");
  const [templates, setTemplates] = useState([
    {
      id: "tpl-fiabilisation",
      name: "Fiabilisation paiements",
      subtitle: "Aperçu email",
      status: "active",
      flow: "Preview + tâche",
      action: "Fiabilisation paiements",
      role: "Compta",
      mode: "Aperçu email",
      description: "Prépare un message simple pour clarifier référence, moyen de paiement et prochaine étape.",
      subject: "Paiements à fiabiliser · {recipient_count} client(s) · {open_balance} € ouverts",
      body: "Campagne {campaign_name}.\n\nClients ciblés : {customer_names}.\nEncours ouvert : {open_balance} €.\nLe message doit clarifier la référence de paiement et la prochaine étape attendue.",
      recipients: 8,
      openBalance: 780,
      tag: "Portefeuille",
    },
    {
      id: "tpl-relance",
      name: "Suivi paiements portefeuille",
      subtitle: "Preview + tâche",
      status: "active",
      flow: "Factures en retard",
      action: "Préparer le suivi du paiement",
      role: "Compta",
      mode: "Aperçu email",
      description:
        "Prépare un message clair avec rappel d'échéance et création d'une tâche interne si le compte reste ouvert.",
      subject: "Suivi paiement · {recipient_count} client(s) · {overdue_balance} € échus",
      body: "Bonjour,\n\nNous revenons vers vous au sujet des factures ouvertes suivantes : {open_balance} €.\nMerci de nous indiquer la date de règlement ou la référence de paiement.",
      recipients: 5,
      openBalance: 520,
      tag: "Preview + tâche",
    },
    {
      id: "tpl-comptes-cles",
      name: "Revue comptes clés",
      subtitle: "Tâche assignée",
      status: "active",
      flow: "Commercial",
      action: "Revue comptes clés",
      role: "Direction",
      mode: "Tâche assignée",
      description: "Cadence simple pour passer les comptes stratégiques en revue avec une note d'action interne.",
      subject: "Revue comptes clés · {recipient_count} compte(s)",
      body: "Passez en revue les comptes clés : {customer_names}.\nSynthèse attendue : opportunité, risque, prochaine relance.",
      recipients: 3,
      openBalance: 0,
      tag: "Comptes clés",
    },
    {
      id: "tpl-reactivation",
      name: "Réactivation dormants",
      subtitle: "Aperçu email",
      status: "draft",
      flow: "Activation",
      action: "Réactivation dormants",
      role: "Marketing",
      mode: "Aperçu email",
      description: "Prépare une relance simple pour réactiver les clients sans activité récente.",
      subject: "On reprend contact ?",
      body: "Bonjour,\n\nNous reprenons contact pour relancer la relation commerciale sur les comptes dormants.",
      recipients: 11,
      openBalance: 0,
      tag: "Dormants",
    },
  ]);
  const [preset, setPreset] = useState("Fiabilisation paiements");
  const activeCount = templates.filter((template) => template.status === "active").length;
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) || templates[0];
  const filteredTemplates = templates.filter((template) => {
    const haystack = [template.name, template.subtitle, template.flow, template.action, template.role]
      .join(" ")
      .toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  });
  const patchSelectedTemplate = (patch: Partial<(typeof templates)[number]>) => {
    setTemplates((current) =>
      current.map((template) => (template.id === selectedTemplate.id ? { ...template, ...patch } : template)),
    );
  };
  const metricStrip = [
    { label: "À jouer", value: 0, detail: "À jouer", tone: "#16a34a" },
    { label: "Previews prêts", value: 0, detail: "Previews prêts", tone: "#6366f1" },
    { label: "Tâches / 7j", value: 0, detail: "Tâches / 7 j", tone: "#d97706" },
    { label: "Templates actifs", value: activeCount, detail: "Templates actifs", tone: "#0891b2" },
  ];
  return (
    <div>
      <AppPageHeader
        title="Campagnes"
        breadcrumb="Pilotage"
        description="Prévisualiser puis exécuter la bonne campagne."
        actions={
          <div className="flex items-center gap-2">
            <SecondaryButton>
              <Inbox className="w-3.5 h-3.5" /> Outbox
            </SecondaryButton>
            <PrimaryButton>
              <Play className="w-3.5 h-3.5" /> Lancer le preset
            </PrimaryButton>
          </div>
        }
      />
      <WorkbenchPage maxWidth="1520px">
        <Card padding={false} className="overflow-hidden">
          <div className="grid divide-[#eef2f7] md:grid-cols-2 md:divide-x xl:grid-cols-4">
            {metricStrip.map((metric, index) => (
              <div
                key={metric.label}
                className={`px-5 py-4 ${index >= 2 ? "border-t border-[#eef2f7] xl:border-t-0" : ""}`}
              >
                <div
                  className="flex items-center gap-2 text-[#94a3b8]"
                  style={{ fontSize: "0.72rem", fontWeight: 760 }}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: metric.tone }} />
                  {metric.label}
                </div>
                <div className="mt-2 flex items-end gap-2">
                  <span className="text-[#0f172a]" style={{ fontSize: "1.8rem", fontWeight: 820, lineHeight: 1 }}>
                    {metric.value}
                  </span>
                  <span className="pb-1 text-[#94a3b8]" style={{ fontSize: "0.78rem", fontWeight: 600 }}>
                    {metric.detail}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-[#0f172a]" style={{ fontSize: "1.12rem", fontWeight: 800 }}>
              Prévisualiser puis exécuter la bonne campagne.
            </div>
            <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.83rem", lineHeight: 1.6 }}>
              Un panneau compact pour préparer le message, la file utile et le prochain clic.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-[#64748b]" style={{ fontSize: "0.78rem", fontWeight: 700 }}>
              Preset
            </div>
            <select
              value={preset}
              onChange={(event) => setPreset(event.target.value)}
              className="min-w-[220px] rounded-2xl border border-[#dbe4ef] bg-white px-4 py-3 text-[#0f172a] outline-none"
              style={{ fontSize: "0.9rem" }}
            >
              {templates.map((template) => (
                <option key={template.id}>{template.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-[260px_minmax(0,1fr)_290px] xl:items-start">
          <Card padding={false} className="overflow-hidden">
            <div className="border-b border-[#eef2f7] px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 760 }}>
                  Templates
                </div>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-white"
                  style={{
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    background: "linear-gradient(135deg,#4f46e5 0%,#2563eb 100%)",
                    boxShadow: "0 10px 22px -18px rgba(79,70,229,0.9)",
                  }}
                >
                  <Plus className="h-3.5 w-3.5" /> Nouveau
                </button>
              </div>
              <div className="mt-3">
                <SearchBar value={search} onChange={setSearch} placeholder="Rechercher…" tint="#2563eb" />
              </div>
            </div>
            <div className="max-h-[640px] divide-y overflow-auto" style={{ borderColor: "#eef2f7" }}>
              {filteredTemplates.map((template) => {
                const selected = template.id === selectedTemplate.id;
                return (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => setSelectedTemplateId(template.id)}
                    className="flex w-full items-start gap-3 px-5 py-4 text-left transition-colors hover:bg-[#fbfdff]"
                    style={{ background: selected ? "#f8fbff" : "transparent" }}
                  >
                    <span
                      className={`mt-1 h-2.5 w-2.5 rounded-full ${template.status === "active" ? "bg-[#22c55e]" : "bg-[#cbd5e1]"}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[#0f172a]" style={{ fontSize: "0.95rem", fontWeight: 740 }}>
                        {template.name}
                      </div>
                      <div className="mt-1 text-[#64748b]" style={{ fontSize: "0.78rem" }}>
                        {template.subtitle}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[#0f172a]" style={{ fontSize: "1.08rem", fontWeight: 780 }}>
                  Nouveau template
                </div>
                <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.82rem", lineHeight: 1.6 }}>
                  Placeholders :{" "}
                  {
                    "{campaign_name}, {recipient_count}, {customer_names}, {open_balance}, {overdue_balance}, {segments}"
                  }
                </p>
              </div>
              <label
                className="inline-flex items-center gap-2 text-[#475569]"
                style={{ fontSize: "0.82rem", fontWeight: 700 }}
              >
                <input
                  type="checkbox"
                  checked={selectedTemplate.status === "active"}
                  onChange={(event) => patchSelectedTemplate({ status: event.target.checked ? "active" : "draft" })}
                />
                Actif
              </label>
            </div>

            <div className="rounded-2xl border border-[#eef2f7] bg-[#fbfdff] p-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-[#334155]" style={{ fontSize: "0.78rem", fontWeight: 700 }}>
                    Nom du template
                  </label>
                  <input
                    value={selectedTemplate.name}
                    onChange={(event) => patchSelectedTemplate({ name: event.target.value })}
                    className="w-full rounded-2xl border border-[#dbe4ef] bg-white px-4 py-3 text-[#0f172a] outline-none"
                    style={{ fontSize: "0.92rem" }}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[#334155]" style={{ fontSize: "0.78rem", fontWeight: 700 }}>
                    Action portefeuille
                  </label>
                  <input
                    value={selectedTemplate.action}
                    onChange={(event) => patchSelectedTemplate({ action: event.target.value })}
                    className="w-full rounded-2xl border border-[#dbe4ef] bg-white px-4 py-3 text-[#0f172a] outline-none"
                    style={{ fontSize: "0.92rem" }}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[#334155]" style={{ fontSize: "0.78rem", fontWeight: 700 }}>
                    Mode de diffusion
                  </label>
                  <select
                    value={selectedTemplate.mode}
                    onChange={(event) => patchSelectedTemplate({ mode: event.target.value })}
                    className="w-full rounded-2xl border border-[#dbe4ef] bg-white px-4 py-3 text-[#0f172a] outline-none"
                    style={{ fontSize: "0.92rem" }}
                  >
                    <option>Aperçu email</option>
                    <option>Tâche assignée</option>
                    <option>Diffusion auto</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-[#334155]" style={{ fontSize: "0.78rem", fontWeight: 700 }}>
                    Rôle pilote
                  </label>
                  <select
                    value={selectedTemplate.role}
                    onChange={(event) => patchSelectedTemplate({ role: event.target.value })}
                    className="w-full rounded-2xl border border-[#dbe4ef] bg-white px-4 py-3 text-[#0f172a] outline-none"
                    style={{ fontSize: "0.92rem" }}
                  >
                    <option>Compta</option>
                    <option>Commercial</option>
                    <option>Direction</option>
                    <option>Marketing</option>
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="mb-1.5 block text-[#334155]" style={{ fontSize: "0.78rem", fontWeight: 700 }}>
                    Description interne
                  </label>
                  <input
                    value={selectedTemplate.description}
                    onChange={(event) => patchSelectedTemplate({ description: event.target.value })}
                    className="w-full rounded-2xl border border-[#dbe4ef] bg-white px-4 py-3 text-[#0f172a] outline-none"
                    style={{ fontSize: "0.92rem" }}
                  />
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-[#eef2f7] bg-white p-4">
              <div className="flex items-center gap-2 text-[#2563eb]" style={{ fontSize: "0.88rem", fontWeight: 740 }}>
                <Mail className="h-4 w-4" /> Message
              </div>
              <div className="mt-4">
                <label className="mb-1.5 block text-[#334155]" style={{ fontSize: "0.78rem", fontWeight: 700 }}>
                  Objet / titre
                </label>
                <input
                  value={selectedTemplate.subject}
                  onChange={(event) => patchSelectedTemplate({ subject: event.target.value })}
                  className="w-full rounded-2xl border border-[#dbe4ef] bg-white px-4 py-3 text-[#0f172a] outline-none"
                  style={{ fontSize: "0.92rem" }}
                />
              </div>
              <div className="mt-4">
                <label className="mb-1.5 block text-[#334155]" style={{ fontSize: "0.78rem", fontWeight: 700 }}>
                  Corps du message / brief
                </label>
                <textarea
                  rows={8}
                  value={selectedTemplate.body}
                  onChange={(event) => patchSelectedTemplate({ body: event.target.value })}
                  className="w-full rounded-2xl border border-[#dbe4ef] bg-white px-4 py-3 text-[#0f172a] outline-none resize-none"
                  style={{ fontSize: "0.92rem", lineHeight: 1.65 }}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <PrimaryButton>
                <Plus className="w-3.5 h-3.5" /> Créer le template
              </PrimaryButton>
              <SecondaryButton onClick={() => setPreset(selectedTemplate.name)}>Réinitialiser</SecondaryButton>
            </div>
          </Card>

          <div className="space-y-5">
            <Card className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 760 }}>
                  <Play className="h-4 w-4 text-[#2563eb]" /> File d'exécution
                </div>
                <span
                  className="rounded-full bg-[#f8fafc] px-2 py-0.5 text-[#94a3b8]"
                  style={{ fontSize: "0.72rem", fontWeight: 700 }}
                >
                  0
                </span>
              </div>
              <div className="rounded-[22px] border border-[#eef2f7] bg-[#fbfdff] px-5 py-10 text-center">
                <Inbox className="mx-auto h-8 w-8 text-[#cbd5e1]" />
                <div className="mt-4 text-[#0f172a]" style={{ fontSize: "0.98rem", fontWeight: 740 }}>
                  File vide
                </div>
                <p className="mt-2 text-[#94a3b8]" style={{ fontSize: "0.82rem", lineHeight: 1.6 }}>
                  Lance une campagne depuis le portefeuille clients pour alimenter cette file.
                </p>
                <div className="mt-5">
                  <SecondaryButton>
                    <Users className="w-3.5 h-3.5" /> Portefeuille
                  </SecondaryButton>
                </div>
              </div>
            </Card>

            <Card className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 760 }}>
                  <Activity className="h-4 w-4 text-[#16a34a]" /> Historique
                </div>
                <span
                  className="rounded-full bg-[#f8fafc] px-2 py-0.5 text-[#94a3b8]"
                  style={{ fontSize: "0.72rem", fontWeight: 700 }}
                >
                  0
                </span>
              </div>
              <div className="rounded-[22px] border border-[#eef2f7] bg-[#fbfdff] px-5 py-10 text-center">
                <Clock className="mx-auto h-8 w-8 text-[#cbd5e1]" />
                <div className="mt-4 text-[#0f172a]" style={{ fontSize: "0.98rem", fontWeight: 740 }}>
                  Aucun run
                </div>
                <p className="mt-2 text-[#94a3b8]" style={{ fontSize: "0.82rem", lineHeight: 1.6 }}>
                  Les exécutions apparaissent ici avec couverture email et tâches créées.
                </p>
              </div>
            </Card>
          </div>
        </div>
      </WorkbenchPage>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   /app/outbox
════════════════════════════════════════════════════════════ */
export function OutboxPage() {
  const messages = [
    { id: "m1", subject: "Votre facture", type: "Facture", status: "delivered", date: "Aujourd'hui 14:32" },
    { id: "m2", subject: "Devis en attente de réponse", type: "Devis", status: "pending", date: "Aujourd'hui 09:15" },
    { id: "m3", subject: "Relance — facture en retard", type: "Relance", status: "failed", date: "Hier 18:00" },
  ];
  const statusCfg: Record<string, { label: string; color: "ok" | "info" | "danger" }> = {
    delivered: { label: "Livré", color: "ok" },
    pending: { label: "En attente", color: "info" },
    failed: { label: "Échec", color: "danger" },
  };
  return (
    <div>
      <AppPageHeader
        title="Outbox"
        breadcrumb="Pilotage"
        description="Messages en transit et statuts de livraison."
        actions={
          <SecondaryButton>
            <RefreshCw className="w-3.5 h-3.5" /> Rafraîchir
          </SecondaryButton>
        }
      />
      <div className="p-6 lg:p-8 max-w-2xl">
        <Card padding={false}>
          {messages.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-[#94a3b8]" style={{ fontSize: "0.875rem" }}>
                Aucun message en transit.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[#f8fafc]">
              {messages.map((m) => (
                <div key={m.id} className="flex items-center gap-4 px-5 py-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-[#374151] truncate" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                      {m.subject}
                    </p>
                    <p className="text-[#94a3b8]" style={{ fontSize: "0.75rem" }}>
                      {m.type} · {m.date}
                    </p>
                  </div>
                  <StatusPill {...statusCfg[m.status]} />
                  {m.status === "failed" && (
                    <button
                      className="px-2.5 py-1.5 rounded-lg text-[#dc2626] bg-[#fef2f2] hover:bg-[#fee2e2] transition-colors flex-shrink-0"
                      style={{ fontSize: "0.75rem", fontWeight: 500 }}
                    >
                      Retenter
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   /app/scheduler
════════════════════════════════════════════════════════════ */
export function SchedulerPage() {
  const [showJobs, setShowJobs] = useState(false);
  const [heartbeat] = useState<"ok" | "warn">("ok");
  const jobs = [
    { id: "j1", name: "Factures récurrentes", cron: "0 6 1 * *", last: "01/03 06:00", status: "ok" },
    { id: "j2", name: "Relances automatiques", cron: "0 9 * * 1", last: "03/03 09:00", status: "ok" },
    { id: "j3", name: "Sync e-reporting DGFiP", cron: "0 3 * * *", last: "04/03 03:00", status: "warn" },
    { id: "j4", name: "Export FEC archive", cron: "0 2 1 * *", last: "01/03 02:05", status: "ok" },
  ];
  return (
    <div>
      <AppPageHeader
        title="Scheduler"
        breadcrumb="Pilotage"
        description="Santé des jobs et supervision des tâches périodiques."
        actions={
          <SecondaryButton>
            <RefreshCw className="w-3.5 h-3.5" /> Actualiser
          </SecondaryButton>
        }
      />
      <div className="p-6 lg:p-8 space-y-5 max-w-2xl">
        <div
          className={`flex items-center gap-3 p-4 rounded-2xl ${heartbeat === "ok" ? "bg-[#f0fdf4] border border-[#bbf7d0]" : "bg-[#fffbeb] border border-[#fde68a]"}`}
        >
          {heartbeat === "ok" ? (
            <CheckCircle2 className="w-5 h-5 text-[#16a34a] flex-shrink-0" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-[#d97706] flex-shrink-0" />
          )}
          <div>
            <p
              className={heartbeat === "ok" ? "text-[#15803d]" : "text-[#92400e]"}
              style={{ fontSize: "0.875rem", fontWeight: 600 }}
            >
              {heartbeat === "ok" ? "Tous les jobs sont opérationnels" : "1 job nécessite une attention"}
            </p>
            <p className={heartbeat === "ok" ? "text-[#16a34a]" : "text-[#b45309]"} style={{ fontSize: "0.75rem" }}>
              {jobs.filter((j) => j.status === "ok").length}/{jobs.length} jobs OK · Dernier check il y a 2 min
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Jobs actifs" value={jobs.length} sub="Configurés" accent="blue" />
          <StatCard
            label="Alertes"
            value={
              jobs.filter((j) => j.status === "warn").length > 0 ? jobs.filter((j) => j.status === "warn").length : "—"
            }
            sub="À vérifier"
            accent={jobs.some((j) => j.status === "warn") ? "amber" : undefined}
          />
          <StatCard label="Prochain run" value="Demain 03:00" sub="Sync e-reporting" />
        </div>

        <div className="bg-white rounded-2xl overflow-hidden" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <button
            onClick={() => setShowJobs((o) => !o)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#f8fafc] transition-colors"
          >
            <span className="text-[#374151]" style={{ fontSize: "0.875rem", fontWeight: 600 }}>
              Détail des jobs
            </span>
            <ChevronDown className={`w-4 h-4 text-[#94a3b8] transition-transform ${showJobs ? "rotate-180" : ""}`} />
          </button>
          {showJobs && (
            <div className="border-t border-[#f8fafc] divide-y divide-[#f8fafc]">
              {jobs.map((j) => (
                <div key={j.id} className="flex items-center justify-between px-5 py-3">
                  <div>
                    <p className="text-[#374151]" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                      {j.name}
                    </p>
                    <p className="text-[#94a3b8] font-mono" style={{ fontSize: "0.6875rem" }}>
                      {j.cron} · dernier : {j.last}
                    </p>
                  </div>
                  <StatusPill status={j.status === "ok" ? "ok" : "warn"} label={j.status === "ok" ? "OK" : "Lent"} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
