"use client";

import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@/figma/react-router-compat";
import { api, extractUserFacingApiMessage, formatApiError, rawApi } from "@/lib/api";
import { downloadProtectedFile } from "@/lib/download";
import { copyTextToClipboard } from "@/lib/clipboard";
import { formatDateFr, formatDateTimeFr } from "@/lib/dateFormat";
import { emailDeliveryProof } from "@/lib/emailDeliveryProof";
import { useCockpit } from "@/lib/useCockpit";
import { useHydrated } from "@/lib/useHydrated";
import { can } from "@/lib/permissions";
import { useSession } from "@/lib/useSession";
import { isTrialSubscription, TRIAL_LIVE_ACTION_MESSAGE } from "@/lib/trialMode";
import {
  AppPageHeader,
  DataTable,
  PrimaryButton,
  PrimaryLinkButton,
  SecondaryButton,
  StatusPill,
} from "../../components/app/AppPageHeader";
import { InvoiceDocumentEditor } from "../../components/app/InvoiceDocumentEditor";
import { InvoiceDocumentPreview, InvoicePreviewFrame } from "./InvoicesPage";
import { EmptyCard, LoadingCard, NoticeBanner } from "../../components/app/Feedback";
import { ModuleOverview } from "../../components/app/ModuleOverview";
import type { ModuleOverviewStat } from "../../components/app/ModuleOverview";
import QuoteEmailModal, {
  type QuoteEmailDefaultTemplatePayload,
  type QuoteEmailPayload,
} from "@/components/QuoteEmailModal";
import { AccountingReadinessPanel } from "@/components/AccountingReadinessPanel";
import { AccountingLineCorrectionPanel } from "@/components/AccountingLineCorrectionPanel";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  XCircle,
} from "lucide-react";

/* ── design tokens ─────────────────────────────────────────── */
const statusMap: Record<string, { label: string; color: "ok" | "warn" | "danger" | "muted" | "info" | "purple" }> = {
  draft: { label: "Brouillon", color: "muted" },
  sent: { label: "Envoyé", color: "info" },
  accepted: { label: "Accepté", color: "ok" },
  rejected: { label: "Refusé", color: "danger" },
  expired: { label: "Expiré", color: "muted" },
  invoiced: { label: "Facturé", color: "purple" },
};

function money(value: any, currency = "EUR") {
  const formatted = Number(value || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${formatted} ${currency === "EUR" ? "€" : currency}`;
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

function digitsOnly(value: any) {
  return String(value || "").replace(/\D+/g, "");
}

function companyProfileMissingForInvoice(profile: any) {
  if (!profile) return ["dossier entreprise"];
  const hasAddress = Boolean(
    String(profile.address || "").trim() ||
    (String(profile.address_line1 || "").trim() &&
      String(profile.postal_code || "").trim() &&
      String(profile.city || "").trim()),
  );
  const isFr = String(profile.country || profile.country_code || "FR").toUpperCase() === "FR";
  return [
    !String(profile.name || "").trim() ? "raison sociale" : null,
    digitsOnly(profile.siret).length !== 14 ? "SIRET" : null,
    !hasAddress ? "adresse" : null,
    isFr && !String(profile.vat_number || profile.vat_exemption_notice || "").trim() ? "TVA ou exonération" : null,
    isFr && !String(profile.late_payment_interest || "").trim() ? "pénalités de retard" : null,
  ].filter(Boolean) as string[];
}

const quotePrimaryButtonStyle = {
  background: "linear-gradient(135deg,#7c3aed 0%,#6d28d9 100%)",
  boxShadow: "0 1px 3px rgba(109,40,217,0.4), inset 0 1px 0 rgba(255,255,255,0.15)",
} as const;

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

/* ── local micro-components ────────────────────────────────── */
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
      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
        active
          ? "bg-[#4f46e5] text-white border-transparent shadow-sm"
          : "bg-white border-[#e2e8f0] text-[#64748b] hover:bg-[#f8fafc]"
      }`}
    >
      {children}
    </button>
  );
}

function Paginator({
  page,
  totalPages,
  onPrev,
  onNext,
  label,
}: {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
  label: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-[#94a3b8]">{label}</span>
      <div className="flex items-center gap-1">
        <button
          className="p-1.5 border border-[#e2e8f0] rounded-lg bg-white hover:bg-[#f8fafc] transition-colors disabled:opacity-40"
          onClick={onPrev}
          disabled={page <= 1}
          aria-label="Page précédente"
        >
          <ChevronLeft className="w-3.5 h-3.5 text-[#94a3b8]" aria-hidden="true" />
        </button>
        <span className="px-3 py-1.5 text-xs font-medium text-[#475569] border border-[#e2e8f0] rounded-lg bg-white tabular-nums">
          {page} / {totalPages}
        </span>
        <button
          className="p-1.5 border border-[#e2e8f0] rounded-lg bg-white hover:bg-[#f8fafc] transition-colors disabled:opacity-40"
          onClick={onNext}
          disabled={page >= totalPages}
          aria-label="Page suivante"
        >
          <ChevronRight className="w-3.5 h-3.5 text-[#94a3b8]" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function quoteInitials(value?: string | null) {
  const parts = String(value || "Client")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "CL";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

function quoteTimelineLabel(action: any) {
  const value = String(action || "").toLowerCase();
  if (value.includes("create")) return "Devis créé";
  if (value.includes("send") || value.includes("email")) return "Devis envoyé";
  if (value.includes("follow")) return "Email de suivi envoyé";
  if (value.includes("accept")) return "Accord client";
  if (value.includes("reject")) return "Refus client";
  if (value.includes("convert")) return "Converti en facture";
  if (value.includes("duplicate")) return "Copie créée";
  if (value.includes("share")) return "Lien public";
  if (value.includes("update")) return "Devis mis à jour";
  return String(action || "Événement devis");
}

function quoteEmailTypeLabel(type: any) {
  const value = String(type || "").toLowerCase();
  if (value.includes("followup")) return "Email de suivi";
  if (value.includes("otp")) return "Code signature";
  return "Email devis";
}

function quoteEmailStatusTone(event: any): "green" | "blue" | "red" | "slate" {
  const proof = emailDeliveryProof(event);
  if (proof.status === "ok") return "green";
  if (proof.status === "danger") return "red";
  if (proof.status === "info") return "blue";
  return "slate";
}

function quoteEmailWasDispatched(event: any) {
  const proof = emailDeliveryProof(event);
  return !proof.isLogOnly && !proof.isFailure && proof.status !== "muted";
}

type QuoteHistoryTone = "purple" | "green" | "blue" | "slate" | "red";

type QuoteHistoryItem = {
  id: string;
  title: string;
  detail: string;
  dateLabel: string;
  sortDate?: string | null;
  tone: QuoteHistoryTone;
};

const quoteHistoryToneMap: Record<QuoteHistoryTone, { bg: string; border: string; dot: string }> = {
  purple: { bg: "#faf5ff", border: "#d8b4fe", dot: "#7c3aed" },
  green: { bg: "#f0fdf4", border: "#bbf7d0", dot: "#10b981" },
  blue: { bg: "#eff6ff", border: "#bfdbfe", dot: "#2563eb" },
  slate: { bg: "#f8fafc", border: "#e2e8f0", dot: "#94a3b8" },
  red: { bg: "#fef2f2", border: "#fecaca", dot: "#dc2626" },
};

function isQuotePublicViewAction(action: any) {
  const value = String(action || "").toLowerCase();
  return (
    value.includes("public_view") ||
    value.includes("view_public") ||
    value.includes("viewed") ||
    value.includes("consult")
  );
}

function isQuoteEmailTimelineAction(action: any) {
  const value = String(action || "").toLowerCase();
  return value.includes("send") || value.includes("email") || value.includes("follow");
}

function quoteTimelineTone(action: any): QuoteHistoryTone {
  const value = String(action || "").toLowerCase();
  if (value.includes("accept") || value.includes("convert")) return "green";
  if (value.includes("reject") || value.includes("fail")) return "red";
  if (value.includes("send") || value.includes("email") || value.includes("follow")) return "blue";
  if (isQuotePublicViewAction(value) || value.includes("share")) return "purple";
  return "slate";
}

function quotePreviewInvoice(quote: any) {
  return {
    ...quote,
    type: "quote",
    due_date: quote?.valid_until || quote?.due_date,
    balance_due: quote?.total_inc_vat || 0,
    template_options: quote?.template_options || {},
    lines: Array.isArray(quote?.lines) ? quote.lines : [],
  };
}

function quotePreviewCustomer(quote: any, customer: any) {
  return {
    ...(customer || {}),
    name: customer?.name || quote?.customer_name || "Client",
    email: customer?.email || quote?.customer_email || "",
  };
}

function QuoteRailSection({
  title,
  icon: Icon,
  tone = "purple",
  children,
  right,
  headingTestId,
  withTopBorder = false,
  open = true,
  collapsible = false,
  onToggle,
}: {
  title: string;
  icon: any;
  tone?: "purple" | "green" | "blue" | "slate" | "red";
  children: React.ReactNode;
  right?: React.ReactNode;
  headingTestId?: string;
  withTopBorder?: boolean;
  open?: boolean;
  collapsible?: boolean;
  onToggle?: () => void;
}) {
  const styles = {
    purple: { bg: "#ede9fe", text: "#7c3aed", headerBg: "#fbfaff", headerBorder: "#ddd6fe" },
    green: { bg: "#dcfce7", text: "#059669", headerBg: "#f8fffb", headerBorder: "#dcfce7" },
    blue: { bg: "#dbeafe", text: "#2563eb", headerBg: "#f8fbff", headerBorder: "#dbeafe" },
    slate: { bg: "#f1f5f9", text: "#64748b", headerBg: "#f8fafc", headerBorder: "#e2e8f0" },
    red: { bg: "#fee2e2", text: "#dc2626", headerBg: "#fffafa", headerBorder: "#fecaca" },
  }[tone];
  const heading = (
    <div data-testid={headingTestId} className="flex min-w-0 items-center gap-2.5">
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{ background: styles.bg, color: styles.text }}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <h3 className="pf-invoice-title truncate text-[#0f172a]">{title}</h3>
    </div>
  );

  if (collapsible) {
    return (
      <section className={`border-b border-[#eef2f7] last:border-b-0 ${withTopBorder ? "border-t" : ""}`}>
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left transition hover:brightness-[0.985]"
          style={{ background: styles.headerBg }}
          aria-expanded={open}
        >
          {heading}
          <span className="flex shrink-0 items-center gap-2">
            {right}
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

  return (
    <section className="pf-invoice-rail-section last:border-b-0">
      <div
        className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2"
        style={{ background: styles.headerBg, borderColor: styles.headerBorder }}
      >
        {heading}
        {right}
      </div>
      <div className="mt-3 space-y-2.5">{children}</div>
    </section>
  );
}

function QuoteRailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#eef2f7] py-2 last:border-0">
      <span className="text-[#94a3b8]" style={{ fontSize: "0.78rem", fontWeight: 620 }}>
        {label}
      </span>
      <span className="text-right text-[#0f172a]" style={{ fontSize: "0.78rem", fontWeight: 720 }}>
        {value}
      </span>
    </div>
  );
}

function QuoteActionTile({
  icon: Icon,
  title,
  detail,
  tone,
  action,
}: {
  icon: any;
  title: string;
  detail: string;
  tone: "purple" | "green" | "blue" | "amber";
  action: React.ReactNode;
}) {
  const styles = {
    purple: { bg: "#f3e8ff", text: "#7c3aed", border: "#d8b4fe", card: "#faf5ff" },
    green: { bg: "#dcfce7", text: "#059669", border: "#bbf7d0", card: "#f0fdf4" },
    blue: { bg: "#dbeafe", text: "#2563eb", border: "#bfdbfe", card: "#eff6ff" },
    amber: { bg: "#fef3c7", text: "#d97706", border: "#fde68a", card: "#fffbeb" },
  }[tone];
  return (
    <div className="pf-invoice-action-card flex items-center gap-2.5 px-3 py-2" style={{ borderColor: styles.border }}>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
          style={{ background: styles.bg, color: styles.text }}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <div className="pf-invoice-action-card-title block truncate">{title}</div>
          <div className="pf-invoice-action-card-detail mt-0.5 block truncate">{detail}</div>
        </div>
      </div>
      {action}
    </div>
  );
}

function QuoteStepStrip({ quote }: { quote: any }) {
  const steps = [
    { key: "draft", label: "Créé", date: quote?.issue_date, active: true, icon: FileText },
    {
      key: "sent",
      label: "Envoyé",
      date: quote?.sent_at,
      active: ["sent", "accepted", "invoiced"].includes(quote?.status),
      icon: Send,
    },
    {
      key: "accepted",
      label: quote?.status === "rejected" ? "Refusé" : "Accepté",
      date: quote?.rejected_at || quote?.accepted_at,
      active: ["accepted", "rejected", "invoiced"].includes(quote?.status),
      icon: quote?.status === "rejected" ? XCircle : CheckCircle2,
    },
    {
      key: "invoiced",
      label: "Facturé",
      date: quote?.invoice_id ? quote?.accepted_at || quote?.sent_at : null,
      active: quote?.status === "invoiced",
      icon: RefreshCw,
    },
  ];
  return (
    <div className="grid gap-3 md:grid-cols-4">
      {steps.map((step, index) => {
        const Icon = step.icon;
        return (
          <div key={step.key} className="relative flex items-center gap-3">
            {index > 0 ? (
              <span className="absolute right-[calc(100%+0.35rem)] top-1/2 hidden h-px w-8 bg-[#d8b4fe] md:block" />
            ) : null}
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
              style={{
                background: step.active ? "#f3e8ff" : "#f1f5f9",
                color: step.active ? "#7c3aed" : "#cbd5e1",
              }}
            >
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[#0f172a]" style={{ fontSize: "0.78rem", fontWeight: 760 }}>
                {step.label}
              </div>
              <div className="truncate text-[#64748b]" style={{ fontSize: "0.72rem", fontWeight: 660 }}>
                {formatDateFr(step.date, step.active ? "Aujourd'hui" : "—")}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   QuotesListPage
   ══════════════════════════════════════════════════════════════ */
export function QuotesListPage() {
  const { overview } = useCockpit();
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const pageSize = 10;

  const loadQuotes = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(pageSize));
      params.set("offset", String((page - 1) * pageSize));
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (search.trim()) params.set("q", search.trim());
      const res = await rawApi(`/api/quotes?${params.toString()}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(extractUserFacingApiMessage(payload, res.status, "Impossible de charger les devis."));
      }
      const data = await res.json().catch(() => []);
      setItems(Array.isArray(data) ? data : []);
      setTotalCount(Number(res.headers.get("x-total-count") || "0") || 0);
    } catch (err) {
      setItems([]);
      setError(formatApiError(err, "Impossible de charger les devis."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadQuotes();
  }, [search, statusFilter, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages = Math.max(1, Math.ceil((totalCount || 0) / pageSize));

  const stats = useMemo(() => {
    const acceptedCount = items.filter((q) => q.status === "accepted").length;
    const sentCount = items.filter((q) => q.status === "sent").length;
    const amount = items.reduce((s, q) => s + Number(q.total_inc_vat || 0), 0);
    return { acceptedCount, sentCount, amount };
  }, [items]);
  const quoteModule = overview?.modules?.quotes;
  const quoteSummary = quoteModule?.summary;
  const quoteFocus = quoteModule?.focus || null;
  const quoteOverviewStats = useMemo<ModuleOverviewStat[]>(
    () => [
      {
        label: "Pipeline total",
        value: quoteSummary?.total_count ?? totalCount,
        detail: `${quoteSummary?.draft_count ?? 0} brouillon(s) en préparation`,
        icon: <FileText className="w-4 h-4" />,
        tone: "blue",
      },
      {
        label: "Montant à signer",
        value: money(quoteSummary?.pipeline_amount ?? stats.amount),
        detail: "Brouillons, envoyés et acceptés",
        icon: <FileText className="w-4 h-4" />,
        tone: "purple",
      },
      {
        label: "En attente",
        value: quoteSummary?.sent_count ?? stats.sentCount,
        detail: "Devis envoyés à reprendre",
        icon: <Clock className="w-4 h-4" />,
        tone: "amber",
      },
      {
        label: "Prêts à facturer",
        value: quoteSummary?.accepted_count ?? stats.acceptedCount,
        detail: `${quoteSummary?.invoiced_count ?? 0} déjà converti(s)`,
        icon: <CheckCircle2 className="w-4 h-4" />,
        tone: "green",
      },
    ],
    [quoteSummary, stats.acceptedCount, stats.amount, stats.sentCount, totalCount],
  );

  const filters = [
    { value: "all", label: "Tous" },
    { value: "draft", label: "Brouillons" },
    { value: "sent", label: "Envoyés" },
    { value: "accepted", label: "Acceptés" },
    { value: "rejected", label: "Refusés" },
    { value: "invoiced", label: "Facturés" },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
      <AppPageHeader
        title="Devis"
        breadcrumb="Commercial"
        description="Devis reliés au parcours complet : envoi, lien public, acceptation, relance et conversion en facture."
        actions={
          <Link
            to="/app/quotes/new"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#4f46e5] text-white text-xs font-medium shadow-sm hover:bg-[#4338ca] transition-all active:scale-[0.98]"
          >
            <Plus className="w-3.5 h-3.5" /> Créer un devis
          </Link>
        }
      />
      <div className="p-5 lg:p-7 w-full space-y-5">
        {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}

        <ModuleOverview
          eyebrow="Pipeline devis"
          title="Le strict utile pour convertir les devis"
          description="Pipeline réel et prochain dossier à reprendre."
          stats={quoteOverviewStats}
          focus={quoteFocus}
          compact
          focusAction={
            quoteFocus?.href ? (
              <Link
                to={quoteFocus.href}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#2563eb] transition-colors hover:text-[#1d4ed8]"
              >
                Ouvrir le dossier prioritaire
              </Link>
            ) : (
              <span className="text-xs leading-relaxed text-[#708197]">
                Gardez le bouton principal pour créer, puis utilisez les filtres ci-dessous pour traiter l'existant.
              </span>
            )
          }
        />

        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
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
          <div className="flex items-center gap-2 px-3 py-2 border border-[#e2e8f0] rounded-lg bg-white max-w-sm">
            <FileText className="w-4 h-4 text-[#94a3b8]" />
            <input
              placeholder="Numéro ou client…"
              className="outline-none bg-transparent text-sm text-[#374151] placeholder:text-[#94a3b8] flex-1"
              value={search}
              onChange={(e) => {
                setPage(1);
                setSearch(e.target.value);
              }}
            />
          </div>
        </div>

        {loading ? (
          <LoadingCard label="Chargement des devis…" />
        ) : items.length === 0 ? (
          <EmptyCard
            compact
            className="border-dashed border-[#dbe5ef] shadow-none"
            title="Aucun devis"
            description="Créez un devis pour lancer votre tunnel commercial et le convertir ensuite en facture."
            action={
              <Link
                to="/app/quotes/new"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#4f46e5] text-white text-xs font-medium shadow-sm hover:bg-[#4338ca] transition-all active:scale-[0.98]"
              >
                <Plus className="w-3.5 h-3.5" /> Créer un devis
              </Link>
            }
          />
        ) : (
          <>
            <DataTable headers={["Numéro", "Date", "Valable jusqu'au", "Client", "Statut", "Total TTC", ""]}>
              {items.map((q) => (
                <tr key={q.id} className="hover:bg-[#f8fafc] transition-colors group">
                  <td className="px-4 py-3">
                    <Link
                      to={`/app/quotes/${q.id}`}
                      className="text-sm font-semibold text-[#2563eb] hover:text-[#1e40af] transition-colors"
                    >
                      {q.number || q.id}
                    </Link>
                    <div className="pf-mobile-row-summary mt-2 flex flex-wrap items-center gap-1.5">
                      <StatusPill
                        color={(statusMap[q.status] || { color: "muted" }).color}
                        label={(statusMap[q.status] || { label: q.status || "—" }).label}
                      />
                      <span className="rounded-full bg-[#f8fafc] px-2 py-0.5 text-[0.6875rem] font-semibold text-[#475569]">
                        {money(q.total_inc_vat || 0, q.currency || "EUR")}
                      </span>
                      <span className="rounded-full bg-[#eff6ff] px-2 py-0.5 text-[0.6875rem] font-semibold text-[#1d4ed8]">
                        {q.customer_name || "Client —"}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-[#475569]">{formatDateFr(q.issue_date, "—")}</td>
                  <td className="px-4 py-3 text-sm text-[#475569]">{formatDateFr(q.valid_until, "—")}</td>
                  <td className="px-4 py-3 text-sm text-[#475569]">{q.customer_name || "—"}</td>
                  <td className="px-4 py-3">
                    <StatusPill
                      color={(statusMap[q.status] || { color: "muted" }).color}
                      label={(statusMap[q.status] || { label: q.status || "—" }).label}
                    />
                  </td>
                  <td className="px-4 py-3 text-sm font-bold text-[#0f172a] tabular-nums">
                    {money(q.total_inc_vat || 0, q.currency || "EUR")}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {q.status === "accepted" && !q.invoice_id ? (
                      <Link
                        to={`/app/quotes/${q.id}`}
                        className="text-xs font-semibold text-[#059669] hover:text-[#047857] transition-colors"
                      >
                        Préparer facture
                      </Link>
                    ) : q.invoice_id ? (
                      <Link
                        to={`/app/invoices/${q.invoice_id}`}
                        className="text-xs font-semibold text-[#2563eb] hover:text-[#1e40af] transition-colors"
                      >
                        Voir facture
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </DataTable>

            <Paginator
              page={page}
              totalPages={totalPages}
              onPrev={() => setPage((c) => Math.max(1, c - 1))}
              onNext={() => setPage((c) => Math.min(totalPages, c + 1))}
              label={`${items.length} devis affiché(s) sur ${totalCount}`}
            />
          </>
        )}
      </div>
    </motion.div>
  );
}

/* ══════════════════════════════════════════════════════════════
   QuoteDetailPage
   ══════════════════════════════════════════════════════════════ */
export function QuoteDetailPage() {
  const hydrated = useHydrated();
  const { id } = useParams();
  const { user, subscriptionStatus } = useSession({ autoRefresh: false });
  const trialDraftOnly = isTrialSubscription(subscriptionStatus);
  const canWriteQuotes = can(user, "quotes:write");
  const canConvertQuotes = can(user, "quotes:convert");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [quote, setQuote] = useState<any>(null);
  const [companyProfile, setCompanyProfile] = useState<any>(null);
  const [customer, setCustomer] = useState<any>(null);
  const [share, setShare] = useState<any>(null);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [emailEvents, setEmailEvents] = useState<any[]>([]);
  const [accountEmail, setAccountEmail] = useState("");
  const [emailOpen, setEmailOpen] = useState(false);
  const [followupEmailOpen, setFollowupEmailOpen] = useState(false);
  const [manualSentOpen, setManualSentOpen] = useState(false);
  const [followupSending, setFollowupSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [openRailSections, setOpenRailSections] = useState<Record<string, boolean>>({});

  const loadDetail = async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [detailRes, companyRes, meRes] = await Promise.all([
        rawApi(`/api/cockpit/quotes/${id}`),
        rawApi("/api/company/profile").catch(() => null),
        rawApi("/api/auth/me").catch(() => null),
      ]);
      if (!detailRes.ok) {
        const payload = await detailRes.json().catch(() => null);
        throw new Error(extractUserFacingApiMessage(payload, detailRes.status, "Devis introuvable."));
      }
      if (companyRes?.ok) {
        setCompanyProfile(await companyRes.json().catch(() => null));
      } else {
        setCompanyProfile(null);
      }
      if (meRes?.ok) {
        const mePayload = await meRes.json().catch(() => null);
        setAccountEmail(String(mePayload?.email || "").trim());
      } else {
        setAccountEmail("");
      }
      const payload = await detailRes.json().catch(() => null);
      const quoteData = payload?.quote;
      setQuote(quoteData);
      setCustomer(null);
      if (quoteData?.customer_id) {
        try {
          const customerRes = await rawApi(`/api/customers/${quoteData.customer_id}`);
          setCustomer(customerRes.ok ? await customerRes.json().catch(() => null) : null);
        } catch {
          setCustomer(null);
        }
      }
      setShare(payload?.share || null);
      setTimeline(Array.isArray(payload?.timeline) ? payload.timeline : []);
      setEmailEvents(Array.isArray(payload?.email_events) ? payload.email_events : []);
    } catch (err) {
      setError(formatApiError(err, "Impossible de charger le devis."));
      setEmailEvents([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDetail();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const action = params.get("action");
    if (action === "email" && canWriteQuotes && !trialDraftOnly) {
      setEmailOpen(true);
    }
    if (canWriteQuotes && !trialDraftOnly && (action === "followup" || action === "relance")) {
      setFollowupEmailOpen(true);
    }
  }, [canWriteQuotes, hydrated, id, trialDraftOnly]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  /* ── actions ─────────────────────────────────────────────── */
  const runAction = async (successLabel: string | ((result: any) => string), cb: () => Promise<any>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await cb();
      setNotice(typeof successLabel === "function" ? successLabel(r) : successLabel);
      await loadDetail();
      return r;
    } catch (err) {
      setError(formatApiError(err, "Cette action n'a pas pu être réalisée. Vérifiez les informations puis réessayez."));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const markSent = async () => {
    if (!canWriteQuotes) return;
    if (trialDraftOnly) {
      setError(TRIAL_LIVE_ACTION_MESSAGE);
      return;
    }
    const result = await runAction("Devis marqué envoyé manuellement. Aucun email n'a été expédié.", () =>
      api(`/api/quotes/${id}/send`, { method: "POST" }),
    );
    if (result) setManualSentOpen(true);
  };

  const sendQuoteEmail = async (payload: QuoteEmailPayload) => {
    if (!canWriteQuotes) return;
    if (trialDraftOnly) {
      setError(TRIAL_LIVE_ACTION_MESSAGE);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result: any = await api(`/api/quotes/${id}/email`, { method: "POST", body: JSON.stringify(payload) });
      setEmailOpen(false);
      setNotice(emailDeliveryNotice(result, "Email envoyé."));
      await loadDetail();
    } catch (err) {
      const message = formatApiError(err, "Envoi du devis impossible.");
      setError(message);
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  };
  const saveQuoteEmailDefault = async (payload: QuoteEmailDefaultTemplatePayload) => {
    await api("/api/company/profile", {
      method: "PATCH",
      body: JSON.stringify({
        quote_email_subject_default: payload.subject_template,
        quote_email_body_default: payload.body_template,
      }),
    });
    setCompanyProfile((prev: any) => ({
      ...(prev || {}),
      quote_email_subject_default: payload.subject_template,
      quote_email_body_default: payload.body_template,
    }));
  };

  const openFollowupEmail = () => {
    if (trialDraftOnly) {
      setError(TRIAL_LIVE_ACTION_MESSAGE);
      return;
    }
    setFollowupEmailOpen(true);
  };
  const sendQuoteFollowup = async (payload: QuoteEmailPayload) => {
    if (!canWriteQuotes) return;
    if (trialDraftOnly) {
      setError(TRIAL_LIVE_ACTION_MESSAGE);
      return;
    }
    setBusy(true);
    setFollowupSending(true);
    setError(null);
    setNotice(null);
    try {
      const result: any = await api(`/api/quotes/${id}/followup`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setFollowupEmailOpen(false);
      setNotice(emailDeliveryNotice(result, "Email envoyé.", "Email en cours d'envoi."));
      await loadDetail();
    } catch (err) {
      const message = formatApiError(err, "Envoi de l'email impossible.");
      setError(message);
      throw new Error(message);
    } finally {
      setFollowupSending(false);
      setBusy(false);
    }
  };
  const saveQuoteFollowupDefault = async (payload: QuoteEmailDefaultTemplatePayload) => {
    await api("/api/company/profile", {
      method: "PATCH",
      body: JSON.stringify({
        quote_followup_subject_default: payload.subject_template,
        quote_followup_body_default: payload.body_template,
      }),
    });
    setCompanyProfile((prev: any) => ({
      ...(prev || {}),
      quote_followup_subject_default: payload.subject_template,
      quote_followup_body_default: payload.body_template,
    }));
  };

  const convertQuote = async () => {
    if (!canConvertQuotes) return;
    const result: any = await runAction(
      (payload: any) => (payload?.already_converted ? "Facture déjà créée." : "Facture créée depuis le devis."),
      async () => {
        const preview: any = await api(`/api/quotes/${id}/conversion-preview`);
        if (preview?.existing_invoice_id) {
          return { invoice_id: preview.existing_invoice_id, already_converted: true };
        }
        if (!preview?.can_convert) {
          const firstBlock = Array.isArray(preview?.blocking) ? preview.blocking[0] : null;
          throw new Error(firstBlock?.message || preview?.reason || "Créez la facture une fois le devis accepté.");
        }
        return api(`/api/quotes/${id}/convert`, { method: "POST" });
      },
    );
    if (result?.invoice_id) window.location.href = `/app/invoices/${result.invoice_id}`;
  };

  const duplicateQuote = async () => {
    if (!canWriteQuotes) return;
    const result: any = await runAction("Copie du devis créée.", () =>
      api(`/api/quotes/${id}/duplicate`, { method: "POST" }),
    );
    if (result?.id) window.location.href = `/app/quotes/new?edit_quote=${result.id}`;
  };

  const updateShare = async (action: "enable" | "rotate" | "disable") => {
    if (!canWriteQuotes) return null;
    if (trialDraftOnly && action !== "disable") {
      setError(TRIAL_LIVE_ACTION_MESSAGE);
      return null;
    }
    if (
      action === "disable" &&
      typeof window !== "undefined" &&
      !window.confirm("Désactiver ce lien client ? Le client ne pourra plus accéder à ce devis avec ce lien.")
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
    if (action === "enable" && quoteStatus === "draft") {
      setError("Marquez ou envoyez le devis avant d'activer un lien client.");
      return;
    }
    setShareBusy(true);
    setError(null);
    setNotice(null);
    try {
      const path =
        action === "enable"
          ? `/api/quotes/${id}/share`
          : action === "rotate"
            ? `/api/quotes/${id}/share/rotate`
            : `/api/quotes/${id}/share/disable`;
      const result: any = await api(path, { method: "POST" });
      setShare(result);
      setNotice(
        action === "enable"
          ? "Lien public activé."
          : action === "rotate"
            ? "Lien public régénéré."
            : "Lien public désactivé.",
      );
      await loadDetail();
      return result;
    } catch (err) {
      setError(formatApiError(err, "Lien public impossible."));
      return null;
    } finally {
      setShareBusy(false);
    }
  };

  const copyQuoteLink = async () => {
    if (trialDraftOnly) {
      setError(TRIAL_LIVE_ACTION_MESSAGE);
      return;
    }
    setError(null);
    setNotice(null);
    try {
      let publicUrl = shareUrl;
      if (!publicUrl) {
        const result = await updateShare("enable");
        publicUrl = result?.public_url || null;
      }
      if (!publicUrl) throw new Error("Lien public indisponible.");
      await copyTextToClipboard(publicUrl);
      setNotice("Lien devis copié.");
    } catch (err) {
      setError(formatApiError(err, "Copie du lien impossible."));
    }
  };

  const isRailOpen = (key: string) => openRailSections[key] !== false;
  const toggleRailSection = (key: string) => {
    setOpenRailSections((prev) => ({ ...prev, [key]: !(prev[key] !== false) }));
  };

  const downloadPdf = async () => {
    try {
      setError(null);
      await downloadProtectedFile(`/api/quotes/${id}/pdf?inline=1`, undefined, true);
      setNotice("PDF ouvert.");
    } catch (err) {
      setError(formatApiError(err, "Téléchargement PDF impossible."));
    }
  };

  /* ── derived state ──────────────────────────────────────── */
  const status = statusMap[quote?.status] || { label: quote?.status || "—", color: "muted" };
  const quoteStatus = String(quote?.status || "").toLowerCase();
  const sourceQuoteId = String(quote?.duplicate_of_id || "");
  const sourceQuoteNumber = String(quote?.duplicate_of_number || "");
  const latestDuplicateId = String(quote?.latest_duplicate_id || "");
  const latestDuplicateNumber = String(quote?.latest_duplicate_number || "");
  const sourceQuoteHref = sourceQuoteId ? `/app/quotes/${sourceQuoteId}` : "";
  const latestDuplicateHref = latestDuplicateId ? `/app/quotes/new?edit_quote=${latestDuplicateId}` : "";
  const quoteIsFrozenForCopy = quoteStatus === "rejected" || quoteStatus === "expired";
  const openLatestDuplicate = () => {
    if (latestDuplicateHref) window.location.href = latestDuplicateHref;
  };
  const shareUrl = share?.public_url || null;
  const canSend = Boolean(
    !trialDraftOnly && canWriteQuotes && quote && ["draft", "sent", "accepted"].includes(quote.status),
  );
  const hasQuoteEmailProof = emailEvents.some(quoteEmailWasDispatched);
  const needsInitialEmailAfterManualSend = Boolean(
    !trialDraftOnly && canWriteQuotes && quote && quote.status === "sent" && !hasQuoteEmailProof,
  );
  const canFollowup = Boolean(
    !trialDraftOnly && canWriteQuotes && quote && quote.status === "sent" && hasQuoteEmailProof,
  );
  const conversionMissingFields = companyProfileMissingForInvoice(companyProfile);
  const conversionProfileReady = conversionMissingFields.length === 0;
  const quoteAcceptedWithoutInvoice = Boolean(quote && quote.status === "accepted" && !quote.invoice_id);
  const conversionBlockReason =
    quoteAcceptedWithoutInvoice && !conversionProfileReady
      ? `Complétez le dossier entreprise avant conversion : ${conversionMissingFields.join(", ")}.`
      : null;
  const canConvert = Boolean(canConvertQuotes && quoteAcceptedWithoutInvoice && conversionProfileReady);
  const isDraft = quote?.status === "draft";
  const editDraftHref = quote ? `/app/quotes/new?edit_quote=${quote.id}` : null;
  const depositDraftHref = quote ? `/app/invoices/new?source_quote=${quote.id}&seed=deposit&deposit_percent=30` : null;
  const quoteShareViewCount = Number(share?.view_count ?? share?.views ?? quote?.public_view_count ?? 0);
  const quoteShareLastViewedAt = share?.last_viewed_at || quote?.public_last_viewed_at || null;
  const quoteShareLastViewedLabel = quoteShareLastViewedAt ? formatDateTimeFr(quoteShareLastViewedAt, "—") : "—";
  const quoteDetailStats: ModuleOverviewStat[] = [
    {
      label: "Statut",
      value: status.label,
      detail: quote?.invoice_id
        ? "Déjà relié à une facture"
        : isDraft
          ? "Encore en brouillon"
          : "Dossier en circulation",
      icon: <FileText className="w-4 h-4" />,
      tone:
        status.color === "ok"
          ? "green"
          : status.color === "danger"
            ? "red"
            : status.color === "info"
              ? "blue"
              : "purple",
    },
    {
      label: "Total TTC",
      value: money(quote?.total_inc_vat || 0, quote?.currency || "EUR"),
      detail: `HT ${money(quote?.total_ex_vat || 0, quote?.currency || "EUR")}`,
      icon: <FileText className="w-4 h-4" />,
      tone: "purple",
    },
    {
      label: "Validité",
      value: formatDateFr(quote?.valid_until, "—"),
      detail: quote?.accepted_at
        ? `Accepté le ${formatDateTimeFr(quote.accepted_at, "—")}`
        : `Émis le ${formatDateFr(quote?.issue_date, "—")}`,
      icon: <Clock className="w-4 h-4" />,
      tone: "blue",
    },
    {
      label: "Audience",
      value: String(quoteShareViewCount),
      detail: share?.enabled ? "Lien actif" : "Lien non activé",
      icon: <Send className="w-4 h-4" />,
      tone: share?.enabled ? "green" : "amber",
    },
  ];
  let quoteDetailFocus: any = null;
  let quoteDetailAction: any = null;
  if (trialDraftOnly) {
    quoteDetailFocus = {
      tone: "info",
      label: "Essai Pro",
      title: "Brouillon et prévisualisation uniquement",
      description: TRIAL_LIVE_ACTION_MESSAGE,
    };
    quoteDetailAction = (
      <PrimaryLinkButton to="/app/billing" style={quotePrimaryButtonStyle}>
        Choisir un abonnement
      </PrimaryLinkButton>
    );
  } else if (canConvert) {
    quoteDetailFocus = {
      tone: "ok",
      label: "Conversion",
      title: "Le devis est prêt à devenir une facture",
      description:
        "Le client a donné son accord. Le meilleur geste maintenant est de convertir ce devis pour enclencher la facturation.",
    };
    quoteDetailAction = (
      <PrimaryButton onClick={convertQuote} disabled={busy} style={quotePrimaryButtonStyle}>
        <RefreshCw className="w-3.5 h-3.5" /> Créer la facture
      </PrimaryButton>
    );
  } else if (conversionBlockReason) {
    quoteDetailFocus = {
      tone: "warn",
      label: "Entreprise",
      title: "Compléter l'entreprise avant conversion",
      description: conversionBlockReason,
    };
    quoteDetailAction = (
      <PrimaryLinkButton to="/app/company" style={quotePrimaryButtonStyle}>
        Compléter l'entreprise
      </PrimaryLinkButton>
    );
  } else if (quoteIsFrozenForCopy && canWriteQuotes) {
    quoteDetailFocus = {
      tone: "warn",
      label: "Copie modifiable",
      title: latestDuplicateId ? "Une copie modifiable existe déjà" : "Faire une copie modifiable",
      description: latestDuplicateId
        ? `Le devis est figé. Continuez les modifications dans ${latestDuplicateNumber || "la copie créée"}.`
        : "Le devis est figé par son statut. Créez une copie brouillon pour corriger et renvoyer une nouvelle version.",
    };
    quoteDetailAction = latestDuplicateHref ? (
      <PrimaryButton onClick={openLatestDuplicate} disabled={busy} style={quotePrimaryButtonStyle}>
        <Copy className="w-3.5 h-3.5" /> Ouvrir la copie
      </PrimaryButton>
    ) : (
      <PrimaryButton onClick={duplicateQuote} disabled={busy} style={quotePrimaryButtonStyle}>
        <Copy className="w-3.5 h-3.5" /> Faire une copie modifiable
      </PrimaryButton>
    );
  } else if (isDraft && canWriteQuotes) {
    quoteDetailFocus = {
      tone: "warn",
      label: "Envoi initial",
      title: "Envoyer le devis au client",
      description:
        "L'email active automatiquement le lien sécurisé pour que le client consulte et accepte le devis depuis le portail.",
    };
    quoteDetailAction = (
      <PrimaryButton onClick={() => setEmailOpen(true)} disabled={busy} style={quotePrimaryButtonStyle}>
        <Mail className="w-3.5 h-3.5" /> Envoyer par email
      </PrimaryButton>
    );
  } else if (needsInitialEmailAfterManualSend) {
    quoteDetailFocus = {
      tone: "warn",
      label: "Email client",
      title: "Envoyer le devis par email",
      description:
        "Le devis est marqué envoyé manuellement, mais aucun email n'a été expédié. Envoie l'email pour créer une trace client.",
    };
    quoteDetailAction = (
      <PrimaryButton onClick={() => setEmailOpen(true)} disabled={busy} style={quotePrimaryButtonStyle}>
        <Mail className="w-3.5 h-3.5" /> Envoyer par email
      </PrimaryButton>
    );
  } else if (canFollowup) {
    quoteDetailFocus = {
      tone: "warn",
      label: "Suivi client",
      title: "Reprendre contact avec le client",
      description:
        "Le devis a été envoyé et reste en attente de retour. Un message de suivi permet de reprendre l'échange sans alourdir la page d'actions rapides.",
    };
    quoteDetailAction = (
      <PrimaryButton onClick={openFollowupEmail} disabled={busy} style={quotePrimaryButtonStyle}>
        <Mail className="w-3.5 h-3.5" /> Écrire au client
      </PrimaryButton>
    );
  } else if (quote?.invoice_id) {
    quoteDetailFocus = {
      tone: "ok",
      label: "Suite du cycle",
      title: "Le dossier a basculé en facturation",
      description:
        "Le devis a déjà été converti. Le prochain pilotage utile se fait maintenant côté facture et encaissement.",
    };
    quoteDetailAction = (
      <PrimaryLinkButton to={`/app/invoices/${quote.invoice_id}`} style={quotePrimaryButtonStyle}>
        <FileText className="w-3.5 h-3.5" /> Ouvrir la facture
      </PrimaryLinkButton>
    );
  } else if (canWriteQuotes) {
    quoteDetailFocus = {
      tone: "info",
      label: "Partage",
      title: "Le devis est prêt à être partagé",
      description:
        "La fiche est prête. Utilisez le lien public ou l'email pour transmettre le devis au client dans un cadre clair et traçable.",
    };
    quoteDetailAction = (
      <PrimaryButton onClick={() => setEmailOpen(true)} disabled={busy} style={quotePrimaryButtonStyle}>
        <Mail className="w-3.5 h-3.5" /> Envoyer par email
      </PrimaryButton>
    );
  } else {
    quoteDetailFocus = {
      tone: "info",
      label: "Consultation",
      title: "Devis en lecture seule",
      description: "Votre rôle permet de consulter ce devis, sans l’envoyer, le modifier, le partager ou le convertir.",
    };
    quoteDetailAction = null;
  }
  const previewDocument = quotePreviewInvoice(quote);
  const previewCustomer = quotePreviewCustomer(quote, customer);
  const quotePreviewVersion = [
    quote?.updated_at,
    quote?.sent_at,
    quote?.accepted_at,
    quote?.status,
    quote?.number,
    quote?.issue_date,
    quote?.service_date,
    quote?.valid_until,
    quote?.payment_terms,
    quote?.purchase_order_number,
    quote?.note,
    quote?.template_key,
    JSON.stringify(quote?.template_options || {}),
    quote?.total_ex_vat,
    quote?.total_vat,
    quote?.total_inc_vat,
    Array.isArray(quote?.lines)
      ? quote.lines
          .map((line: any) =>
            [
              line?.id,
              line?.line_type,
              line?.display_number,
              line?.reference,
              line?.product_name,
              line?.detail,
              line?.quantity,
              line?.unit_price,
              line?.vat_rate,
              line?.vat_category,
              line?.exemption_reason_code,
              line?.unit_code,
              line?.item_id,
              line?.accounting_account,
              line?.line_total,
            ].join(":"),
          )
          .join("~")
      : 0,
  ]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .join("|");
  const customerName = customer?.name || quote?.customer_name || "Client";
  const customerEmail = customer?.email || quote?.customer_email || "";
  const quoteEmailSubjectTemplate = (companyProfile?.quote_email_subject_default || "Votre devis {number}").trim();
  const quoteEmailBodyTemplate = (
    companyProfile?.quote_email_body_default ||
    [
      "Bonjour {client},",
      "",
      "Votre devis {number} est disponible. Montant TTC : {total_ttc} {currency}.",
      "Il est valable jusqu'au {valid_until}.",
      "",
      "Pour accepter ou signer ce devis, cliquez sur le bouton « Voir le devis », puis validez-le depuis le portail sécurisé. Tant que cette validation n'est pas faite, le devis reste en attente.",
    ].join("\n")
  ).trim();
  const quoteFollowupSubjectTemplate = (
    companyProfile?.quote_followup_subject_default || "Suivi du devis {number}"
  ).trim();
  const quoteFollowupBodyTemplate = (
    companyProfile?.quote_followup_body_default ||
    [
      "Bonjour {client},",
      "",
      "Nous revenons vers vous au sujet du devis {number}, toujours en attente de votre retour.",
      "Valable jusqu'au {valid_until}.",
      "",
      "Il reste consultable depuis le portail sécurisé. Nous restons disponibles si vous souhaitez une précision ou un ajustement.",
    ].join("\n")
  ).trim();
  const quoteReplyTo = firstDocumentContactEmail(companyProfile?.email_reply_to, accountEmail, companyProfile?.email);
  const quoteEmailTemplateVariables = {
    "{client}": customerName,
    "{company}": companyProfile?.name || "votre entreprise",
    "{number}": quote?.number || "",
    "{issue_date}": formatDateFr(quote?.issue_date, ""),
    "{valid_until}": formatDateFr(quote?.valid_until, ""),
    "{reply_to}": quoteReplyTo,
    "{total_ht}": money(quote?.total_ex_vat || 0, quote?.currency || "EUR"),
    "{total_tva}": money(quote?.total_vat || 0, quote?.currency || "EUR"),
    "{total_ttc} {currency}": money(quote?.total_inc_vat || 0, quote?.currency || "EUR"),
    "{total_ttc}": money(quote?.total_inc_vat || 0, quote?.currency || "EUR"),
    "{currency}": quote?.currency === "EUR" ? "€" : quote?.currency || "EUR",
    "{quote_link}": "le lien sécurisé",
  };
  const quoteEmailSubject = renderEmailTemplateText(quoteEmailSubjectTemplate, quoteEmailTemplateVariables);
  const quoteEmailBody = renderEmailTemplateText(quoteEmailBodyTemplate, quoteEmailTemplateVariables);
  const quoteFollowupSubject = renderEmailTemplateText(quoteFollowupSubjectTemplate, quoteEmailTemplateVariables);
  const quoteFollowupBody = renderEmailTemplateText(quoteFollowupBodyTemplate, quoteEmailTemplateVariables);
  const quoteAttachmentName = `devis-${quote?.number || "brouillon"}.pdf`;
  const quoteShareActive = Boolean(share?.enabled && shareUrl);
  const canActivateQuoteShare = Boolean(
    !trialDraftOnly && canWriteQuotes && quote && !["draft", "rejected", "invoiced", "expired"].includes(quoteStatus),
  );
  const quoteShareStatus = quoteShareActive ? "Actif" : "Inactif";
  const quoteShareTone = quoteShareActive
    ? { bg: "#f0fdf4", text: "#059669", border: "#bbf7d0", dot: "#10b981" }
    : { bg: "#f8fafc", text: "#64748b", border: "#e2e8f0", dot: "#cbd5e1" };
  const quoteShareSummary =
    quoteShareViewCount > 0
      ? `${quoteShareViewCount} vue(s)${quoteShareLastViewedLabel !== "—" ? ` · dernière consultation ${quoteShareLastViewedLabel}.` : ""}`
      : quoteShareActive
        ? "Aucune consultation enregistrée."
        : quoteStatus === "draft"
          ? "Lien disponible après envoi du devis."
          : "Lien client inactif.";
  const quoteRailHistoryEvents = useMemo<QuoteHistoryItem[]>(() => {
    const rawTimeline = Array.isArray(timeline) ? timeline : [];
    const latestPublicViewIndex = rawTimeline.reduce((latestIndex, event, index) => {
      if (!isQuotePublicViewAction(event?.action)) return latestIndex;
      const currentTime = Date.parse(String(event?.created_at || "")) || 0;
      const latestTime =
        latestIndex >= 0
          ? Date.parse(String(rawTimeline[latestIndex]?.created_at || "")) || 0
          : Number.NEGATIVE_INFINITY;
      return currentTime >= latestTime ? index : latestIndex;
    }, -1);
    const hasEmailProof = emailEvents.some(quoteEmailWasDispatched);
    const hasAcceptTimeline = rawTimeline.some((event) =>
      String(event?.action || "")
        .toLowerCase()
        .includes("accept"),
    );
    const hasRejectTimeline = rawTimeline.some((event) =>
      String(event?.action || "")
        .toLowerCase()
        .includes("reject"),
    );

    const timelineHistory = rawTimeline
      .filter((event, index) => {
        if (hasEmailProof && isQuoteEmailTimelineAction(event?.action)) return false;
        if (isQuotePublicViewAction(event?.action)) return index === latestPublicViewIndex;
        return true;
      })
      .map((event, index) => ({
        id: `timeline-${event?.id || index}`,
        title: quoteTimelineLabel(event?.action),
        detail: isQuotePublicViewAction(event?.action) ? "Consultation client" : event?.actor_email || "Par PixFacture",
        dateLabel: formatDateTimeFr(event?.created_at, "—"),
        sortDate: event?.created_at || null,
        tone: quoteTimelineTone(event?.action),
      }));

    const emailHistory = emailEvents.map((event, index) => {
      const proof = emailDeliveryProof(event);
      const statusTone = quoteEmailStatusTone(event);
      return {
        id: `email-${event?.id || index}`,
        title: quoteEmailTypeLabel(event?.type),
        detail: event?.to || proof.title || "Email client",
        dateLabel: formatDateTimeFr(proof.date || event?.sent_at || event?.created_at, "—"),
        sortDate: proof.date || event?.sent_at || event?.created_at || null,
        tone:
          statusTone === "green" ? "green" : statusTone === "red" ? "red" : statusTone === "blue" ? "blue" : "slate",
      } satisfies QuoteHistoryItem;
    });

    const agreementHistory: QuoteHistoryItem[] = [];
    if (quote?.accepted_at && !hasAcceptTimeline) {
      agreementHistory.push({
        id: "accepted",
        title: "Accord client",
        detail: quote?.accepted_name ? `Accepté par ${quote.accepted_name}` : "Accepté en ligne",
        dateLabel: formatDateTimeFr(quote.accepted_at, "—"),
        sortDate: quote.accepted_at,
        tone: "green",
      });
    }
    if (quote?.rejected_at && !hasRejectTimeline) {
      agreementHistory.push({
        id: "rejected",
        title: "Refus client",
        detail: "Refus enregistré",
        dateLabel: formatDateTimeFr(quote.rejected_at, "—"),
        sortDate: quote.rejected_at,
        tone: "red",
      });
    }

    return [...emailHistory, ...agreementHistory, ...timelineHistory].sort((a, b) => {
      const left = Date.parse(String(a.sortDate || "")) || 0;
      const right = Date.parse(String(b.sortDate || "")) || 0;
      return right - left;
    });
  }, [emailEvents, quote?.accepted_at, quote?.accepted_name, quote?.rejected_at, timeline]);

  return (
    <motion.div
      className="pf-invoice-detail"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <AppPageHeader
        title={quote?.number || "Devis"}
        breadcrumb={quote?.number ? `Devis · ${quote.number}` : "Devis"}
        backHref="/app/quotes"
        badge={
          quote ? (
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={status.color} label={status.label} />
              {quote.accounting_readiness ? (
                <AccountingReadinessPanel readiness={quote.accounting_readiness} compact />
              ) : null}
            </div>
          ) : null
        }
        actions={
          quote ? (
            <div className="flex flex-wrap justify-end gap-2">
              <SecondaryButton
                onClick={() => {
                  if (editDraftHref) window.location.assign(editDraftHref);
                }}
                disabled={!canWriteQuotes || !isDraft || !editDraftHref || busy}
                title={isDraft ? "Modifier le brouillon" : "Un devis déjà envoyé se corrige avec une copie modifiable."}
              >
                <Pencil className="w-3.5 h-3.5" />
                Modifier
              </SecondaryButton>
              <SecondaryButton
                onClick={markSent}
                disabled={!canWriteQuotes || !isDraft || busy}
                title="Marque le devis comme envoyé sans déclencher d'email client."
              >
                <Send className="w-3.5 h-3.5" />
                Marquer envoyé
              </SecondaryButton>
              <SecondaryButton
                onClick={latestDuplicateHref ? openLatestDuplicate : duplicateQuote}
                disabled={busy}
                title={
                  latestDuplicateHref
                    ? "Une copie modifiable existe déjà pour ce devis."
                    : "Créer un nouveau brouillon relié à ce devis."
                }
              >
                <Copy className="w-3.5 h-3.5" />
                {latestDuplicateHref ? "Ouvrir la copie modifiable" : "Créer une copie modifiable"}
              </SecondaryButton>
            </div>
          ) : null
        }
      />

      <div className="w-full space-y-5 p-5 lg:p-6">
        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
        {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}
        {sourceQuoteHref ? (
          <NoticeBanner tone="info">
            Copie modifiable de{" "}
            <Link className="font-semibold underline underline-offset-2" to={sourceQuoteHref}>
              {sourceQuoteNumber || "ce devis"}
            </Link>
            .
          </NoticeBanner>
        ) : latestDuplicateHref ? (
          <NoticeBanner tone="info">
            Copie modifiable créée :{" "}
            <Link className="font-semibold underline underline-offset-2" to={latestDuplicateHref}>
              {latestDuplicateNumber || "ouvrir la copie"}
            </Link>
            .
          </NoticeBanner>
        ) : null}
        {quote ? (
          <AccountingLineCorrectionPanel
            documentId={quote.id}
            documentType="quote"
            status={quote.status}
            lines={quote.lines}
            onSaved={loadDetail}
          />
        ) : null}

        {!hydrated && loading ? (
          <EmptyCard title="Devis" description="Ouverture du devis." />
        ) : loading ? (
          <LoadingCard label="Chargement du devis…" />
        ) : !quote ? (
          <EmptyCard title="Devis introuvable" description="Ce devis n'a pas pu être chargé." />
        ) : (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div className="min-w-0 space-y-5">
              <section className="overflow-hidden rounded-2xl border border-[#dbe4ef] bg-white shadow-[0_18px_42px_-32px_rgba(15,23,42,0.65)]">
                <div className="grid gap-5 border-b border-[#eef2f7] px-5 py-5 lg:grid-cols-[minmax(220px,0.7fr)_minmax(0,1fr)]">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#f3e8ff] text-[#7c3aed]">
                      <Send className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <div
                        className="text-[#94a3b8]"
                        style={{
                          fontSize: "0.64rem",
                          fontWeight: 850,
                          letterSpacing: "0.11em",
                          textTransform: "uppercase",
                        }}
                      >
                        Prochaine action
                      </div>
                      <h2 className="truncate text-[#0f172a]" style={{ fontSize: "0.95rem", fontWeight: 780 }}>
                        {quoteDetailFocus.title}
                      </h2>
                      <p
                        className="mt-0.5 line-clamp-2 text-[#64748b]"
                        style={{ fontSize: "0.78rem", fontWeight: 560 }}
                      >
                        {quoteDetailFocus.description}
                      </p>
                    </div>
                  </div>
                  <QuoteStepStrip quote={quote} />
                </div>

                <div className="grid gap-3 px-5 py-4 md:grid-cols-4">
                  {quoteDetailStats.map((stat) => (
                    <div key={stat.label} className="rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <span
                          className="text-[#94a3b8]"
                          style={{
                            fontSize: "0.64rem",
                            fontWeight: 850,
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                          }}
                        >
                          {stat.label}
                        </span>
                        <span className="text-[#7c3aed]">{stat.icon}</span>
                      </div>
                      <div className="mt-2 text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 800 }}>
                        {String(stat.value)}
                      </div>
                      <div className="mt-0.5 truncate text-[#94a3b8]" style={{ fontSize: "0.72rem", fontWeight: 560 }}>
                        {stat.detail}
                      </div>
                    </div>
                  ))}
                </div>

                {conversionBlockReason ? (
                  <div className="border-t border-[#eef2f7] px-5 py-3">
                    <NoticeBanner tone="warning">{conversionBlockReason}</NoticeBanner>
                  </div>
                ) : null}
              </section>

              <InvoicePreviewFrame
                onPrint={downloadPdf}
                htmlPreviewPath={`/api/quotes/${id}/preview.html`}
                previewVersion={quotePreviewVersion}
              >
                <InvoiceDocumentPreview
                  invoice={previewDocument}
                  company={companyProfile}
                  customer={previewCustomer}
                  status={status}
                />
              </InvoicePreviewFrame>
            </div>

            <aside className="pf-invoice-rail self-start xl:sticky xl:top-20">
              <section className="pf-invoice-rail-section">
                <div className="flex items-center gap-3">
                  <span
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#7c3aed] text-white"
                    style={{ fontSize: "0.78rem", fontWeight: 850 }}
                  >
                    {quoteInitials(customerName)}
                  </span>
                  <div className="min-w-0">
                    {quote.customer_id ? (
                      <Link
                        to={`/app/customers/${quote.customer_id}`}
                        className="block truncate text-[#0f172a] transition hover:text-[#6d28d9] hover:underline hover:underline-offset-2"
                        title={`Ouvrir la fiche client ${customerName}`}
                        style={{ fontSize: "1rem", fontWeight: 800 }}
                      >
                        {customerName}
                      </Link>
                    ) : (
                      <div className="truncate text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 800 }}>
                        {customerName}
                      </div>
                    )}
                    <div className="truncate text-[#6d28d9]" style={{ fontSize: "0.78rem", fontWeight: 560 }}>
                      {customerEmail || "Email non renseigné"}
                    </div>
                  </div>
                </div>
              </section>

              <div className="pf-invoice-rail-section space-y-2">
                <QuoteActionTile
                  icon={Mail}
                  title="Email"
                  detail={
                    canFollowup
                      ? "Message de suivi"
                      : needsInitialEmailAfterManualSend
                        ? "Aucun email expédié"
                        : quote?.status === "accepted"
                          ? "Envoyer une copie"
                          : canSend
                            ? "À envoyer au client"
                            : "Indisponible"
                  }
                  tone="blue"
                  action={
                    <button
                      type="button"
                      onClick={canFollowup ? openFollowupEmail : () => setEmailOpen(true)}
                      disabled={!canSend || busy}
                      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-[#bfdbfe] bg-white px-2.5 text-[#2563eb] disabled:opacity-50"
                      style={{ fontSize: "0.72rem", fontWeight: 650 }}
                    >
                      {canFollowup ? "Écrire" : "Envoyer"} <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  }
                />
                <QuoteActionTile
                  icon={CheckCircle2}
                  title="Signature"
                  detail={
                    quote?.accepted_at ? "Accord enregistré" : quoteShareActive ? "Lien client actif" : "Lien à activer"
                  }
                  tone={quote?.accepted_at ? "green" : quoteShareActive ? "purple" : "amber"}
                  action={
                    quoteShareActive && shareUrl ? (
                      <button
                        type="button"
                        onClick={() => window.open(shareUrl, "_blank", "noopener,noreferrer")}
                        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-[#d8b4fe] bg-white px-2.5 text-[#7c3aed]"
                        style={{ fontSize: "0.72rem", fontWeight: 650 }}
                      >
                        Ouvrir <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => updateShare("enable")}
                        disabled={!canWriteQuotes || shareBusy || busy}
                        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-[#fde68a] bg-white px-2.5 text-[#d97706] disabled:opacity-50"
                        style={{ fontSize: "0.72rem", fontWeight: 650 }}
                      >
                        Activer <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    )
                  }
                />
                <QuoteActionTile
                  icon={RefreshCw}
                  title="Facturation"
                  detail={
                    quote?.invoice_id
                      ? "Facture créée"
                      : canConvert
                        ? "Prêt à facturer"
                        : quote?.status === "accepted"
                          ? "Entreprise à compléter"
                          : "En attente d’accord client"
                  }
                  tone="green"
                  action={
                    quote?.invoice_id ? (
                      <Link
                        to={`/app/invoices/${quote.invoice_id}`}
                        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-[#bbf7d0] bg-white px-2.5 text-[#059669]"
                        style={{ fontSize: "0.72rem", fontWeight: 650 }}
                      >
                        Voir <ChevronRight className="h-3.5 w-3.5" />
                      </Link>
                    ) : (
                      <button
                        type="button"
                        onClick={convertQuote}
                        disabled={!canConvert || busy}
                        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-[#bbf7d0] bg-white px-2.5 text-[#059669] disabled:opacity-50"
                        style={{ fontSize: "0.72rem", fontWeight: 650 }}
                      >
                        Créer la facture <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    )
                  }
                />
              </div>

              <QuoteRailSection
                title="Historique"
                icon={Clock}
                tone="purple"
                headingTestId="quote-history-heading"
                withTopBorder
                collapsible
                open={isRailOpen("history")}
                onToggle={() => toggleRailSection("history")}
              >
                {quoteRailHistoryEvents.length ? (
                  <div className="invoice-history-scrollbar max-h-72 space-y-0 overflow-y-auto pr-1">
                    {quoteRailHistoryEvents.map((event, index) => {
                      const palette = quoteHistoryToneMap[event.tone];
                      return (
                        <div key={event.id} className="relative flex gap-3">
                          {index < quoteRailHistoryEvents.length - 1 ? (
                            <span
                              className="absolute left-[10px] top-[22px] h-[calc(100%-12px)] w-px bg-[#edf2f7]"
                              aria-hidden="true"
                            />
                          ) : null}
                          <span
                            className="relative z-10 mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                            style={{ background: palette.bg, border: `1px solid ${palette.border}` }}
                          >
                            <span className="h-1.5 w-1.5 rounded-full" style={{ background: palette.dot }} />
                          </span>
                          <div className="min-w-0 pb-4">
                            <div className="truncate text-[#0f172a]" style={{ fontSize: "0.8rem", fontWeight: 760 }}>
                              {event.title}
                            </div>
                            <div className="truncate text-[#94a3b8]" style={{ fontSize: "0.72rem", fontWeight: 560 }}>
                              {event.detail}
                            </div>
                            <div className="text-[#bfbae8]" style={{ fontSize: "0.68rem", fontWeight: 650 }}>
                              {event.dateLabel}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-[#94a3b8]" style={{ fontSize: "0.78rem" }}>
                    Aucun événement commercial à afficher.
                  </p>
                )}
              </QuoteRailSection>

              <QuoteRailSection
                title="Document"
                icon={FileText}
                tone="purple"
                collapsible
                open={isRailOpen("document")}
                onToggle={() => toggleRailSection("document")}
              >
                <div className="space-y-0.5">
                  <QuoteRailRow label="Numéro" value={quote.number || "Brouillon"} />
                  <QuoteRailRow label="Client" value={customerName} />
                  <QuoteRailRow label="Émission" value={formatDateFr(quote.issue_date, "—")} />
                  <QuoteRailRow label="Validité" value={formatDateFr(quote.valid_until, "—")} />
                  <QuoteRailRow label="Commande" value={quote.purchase_order_number || "—"} />
                  <QuoteRailRow label="Statut" value={<StatusPill color={status.color} label={status.label} />} />
                </div>
              </QuoteRailSection>

              <QuoteRailSection
                title="Partage client"
                icon={Globe}
                tone="purple"
                right={
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5"
                    style={{
                      background: quoteShareTone.bg,
                      border: `1px solid ${quoteShareTone.border}`,
                      color: quoteShareTone.text,
                      fontSize: "0.62rem",
                      fontWeight: 820,
                    }}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: quoteShareTone.dot }} />
                    {quoteShareStatus}
                  </span>
                }
                collapsible
                open={isRailOpen("partage")}
                onToggle={() => toggleRailSection("partage")}
              >
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <div
                      className="min-w-0 flex-1 truncate rounded-xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2 font-mono text-[#64748b]"
                      style={{ fontSize: "0.68rem" }}
                      title={shareUrl || "Aucun lien actif"}
                    >
                      {shareUrl || "Aucun lien actif"}
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        if (!shareUrl) return;
                        await copyTextToClipboard(shareUrl);
                        setNotice("Lien devis copié.");
                      }}
                      disabled={!shareUrl}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#e2e8f0] bg-white text-[#64748b] disabled:opacity-45"
                      aria-label="Copier le lien public"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[#94a3b8]"
                    style={{ fontSize: "0.72rem" }}
                  >
                    <span>{quoteShareSummary}</span>
                  </div>
                  <div className="grid gap-2">
                    {!quoteShareActive ? (
                      <button
                        type="button"
                        onClick={() => updateShare("enable")}
                        disabled={!canWriteQuotes || shareBusy || !canActivateQuoteShare}
                        title={
                          canActivateQuoteShare
                            ? "Activer le lien client."
                            : "Marquez ou envoyez le devis avant d'activer un lien client."
                        }
                        className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-[#bbf7d0] bg-[#f0fdf4] text-[#059669] disabled:opacity-50"
                        style={{ fontSize: "0.78rem", fontWeight: 820 }}
                      >
                        <Globe className="h-3.5 w-3.5" /> Activer le lien
                      </button>
                    ) : (
                      <div className="grid grid-cols-[1fr_1fr_42px] gap-2">
                        <button
                          type="button"
                          onClick={() => shareUrl && window.open(shareUrl, "_blank", "noopener,noreferrer")}
                          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-[#dbe4ef] bg-white text-[#334155]"
                          style={{ fontSize: "0.76rem", fontWeight: 780 }}
                        >
                          <ExternalLink className="h-3.5 w-3.5" /> Ouvrir
                        </button>
                        <button
                          type="button"
                          onClick={() => updateShare("disable")}
                          disabled={!canWriteQuotes || shareBusy}
                          className="inline-flex h-10 items-center justify-center rounded-xl border border-[#fecaca] bg-[#fef2f2] text-[#dc2626] disabled:opacity-50"
                          style={{ fontSize: "0.76rem", fontWeight: 780 }}
                        >
                          Désactiver
                        </button>
                        <button
                          type="button"
                          onClick={() => updateShare("rotate")}
                          disabled={!canWriteQuotes || shareBusy}
                          className="inline-flex h-10 items-center justify-center rounded-xl border border-[#dbe4ef] bg-white text-[#64748b] disabled:opacity-50"
                          aria-label="Régénérer le lien"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </QuoteRailSection>
            </aside>
          </div>
        )}
      </div>

      <QuoteEmailModal
        open={!trialDraftOnly && emailOpen}
        previewEndpoint={id ? `/api/quotes/${id}/email/preview` : null}
        defaultTo={customerEmail || ""}
        defaultFrom={quoteReplyTo}
        defaultSubject={quoteEmailSubject}
        defaultBody={quoteEmailBody}
        defaultAttachmentName={quoteAttachmentName}
        showSaveDefault
        saveDefaultLabel="Enregistrer ce mail devis par défaut"
        saveDefaultHelp="Le texte sera réutilisé et adapté automatiquement aux prochains devis."
        saveDefaultStorageKey="pixfacture:quote-email-default"
        templateVariables={quoteEmailTemplateVariables}
        onSaveDefault={saveQuoteEmailDefault}
        submitting={busy}
        onClose={() => setEmailOpen(false)}
        onSend={sendQuoteEmail}
      />
      {manualSentOpen ? (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-[#0f172a]/45 px-4 py-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="manual-sent-title"
        >
          <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-[#bfdbfe] bg-white shadow-[0_24px_70px_rgba(15,23,42,0.25)]">
            <div className="border-b border-[#e2e8f0] px-5 py-4">
              <p id="manual-sent-title" className="text-[#0f172a]" style={{ fontSize: "1rem", fontWeight: 900 }}>
                Devis marqué envoyé sans email
              </p>
              <p className="mt-1 text-[#64748b]" style={{ fontSize: "0.8125rem", lineHeight: 1.45 }}>
                Le statut avance pour ton suivi interne, mais aucun message n'a été expédié au client et aucune preuve
                d'envoi email n'a été créée.
              </p>
            </div>
            <div className="space-y-3 px-5 py-4 text-[#334155]" style={{ fontSize: "0.8125rem", lineHeight: 1.45 }}>
              <p>
                Pour prévenir le client depuis l'application, utilise maintenant l'action{" "}
                <strong>Envoyer par email</strong>.
              </p>
              <p>
                Si le devis a déjà été transmis hors application, conserve ce statut manuel et ajoute la preuve dans ton
                suivi si nécessaire.
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-[#e2e8f0] bg-[#f8fafc] px-5 py-4">
              <SecondaryButton onClick={() => setManualSentOpen(false)}>Fermer</SecondaryButton>
              <PrimaryButton
                onClick={() => {
                  setManualSentOpen(false);
                  setEmailOpen(true);
                }}
                style={quotePrimaryButtonStyle}
              >
                <Mail className="h-3.5 w-3.5" /> Envoyer par email
              </PrimaryButton>
            </div>
          </div>
        </div>
      ) : null}
      <QuoteEmailModal
        open={!trialDraftOnly && followupEmailOpen}
        previewEndpoint={id ? `/api/quotes/${id}/followup/preview` : null}
        title="Écrire au client"
        submitLabel="Envoyer l'email"
        defaultTo={customerEmail || ""}
        defaultFrom={quoteReplyTo}
        defaultSubject={quoteFollowupSubject}
        defaultBody={quoteFollowupBody}
        defaultAttachmentName={quoteAttachmentName}
        defaultIncludePdf={false}
        defaultIncludeLink={false}
        attachmentLabel="Ajouter le PDF du devis en pièce jointe"
        helperText="L'aperçu reprend exactement le contenu qui sera envoyé au client."
        showSaveDefault
        saveDefaultLabel="Enregistrer cette relance devis par défaut"
        saveDefaultHelp="Le texte sera réutilisé et adapté automatiquement aux prochaines relances devis."
        saveDefaultStorageKey="pixfacture:quote-followup-email-default"
        templateVariables={quoteEmailTemplateVariables}
        onSaveDefault={saveQuoteFollowupDefault}
        submitting={followupSending}
        onClose={() => setFollowupEmailOpen(false)}
        onSend={sendQuoteFollowup}
      />
    </motion.div>
  );
}

/* ══════════════════════════════════════════════════════════════
   QuoteNewPage
   ══════════════════════════════════════════════════════════════ */
export function QuoteNewPage() {
  return <InvoiceDocumentEditor mode="quote" backHref="/app/quotes" />;
}
