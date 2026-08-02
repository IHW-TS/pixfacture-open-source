import { type ElementType, type ReactNode, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { AppPageHeader, StatusPill } from "../../components/app/AppPageHeader";
import { NoticeBanner } from "../../components/app/Feedback";
import {
  FileText,
  Send,
  Plus,
  ArrowRight,
  RefreshCw,
  Wallet,
  Settings2,
  Landmark,
  Zap,
  CheckCircle2,
} from "lucide-react";
import { motion } from "motion/react";
import { formatApiError, rawApi } from "@/lib/api";
import { useWorkspaceSummary } from "@/lib/useWorkspaceSummary";
import { useSession } from "@/lib/useSession";
import { useHydrated } from "@/lib/useHydrated";
import { WorkbenchPage } from "../../components/app/WorkbenchLayout";

const statusPillMap: Record<string, { label: string; color: "ok" | "warn" | "danger" | "muted" | "info" | "purple" }> =
  {
    draft: { label: "Brouillon", color: "muted" },
    sent: { label: "Envoyé", color: "info" },
    accepted: { label: "Accepté", color: "ok" },
    rejected: { label: "Refusé", color: "danger" },
    expired: { label: "Expiré", color: "muted" },
    invoiced: { label: "Facturé", color: "purple" },
    issued: { label: "Émise", color: "info" },
    partial: { label: "Partielle", color: "warn" },
    paid: { label: "Payée", color: "ok" },
    overdue: { label: "En retard", color: "danger" },
    canceled: { label: "Annulée", color: "muted" },
  };

function money(value: any) {
  return `${Number(value || 0).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

function compactMoney(value: any) {
  return `${Number(value || 0).toLocaleString("fr-FR", {
    maximumFractionDigits: 0,
  })} €`;
}

function safeNumber(value: any) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function pluralFr(count: number, singular: string, plural = `${singular}s`) {
  return `${count.toLocaleString("fr-FR")} ${count === 1 ? singular : plural}`;
}

const DOCUMENT_ID_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function docNumber(item: any) {
  const status = String(item?.status || "").toLowerCase();
  const explicit = item?.number || item?.code || item?.reference;
  if (explicit && !DOCUMENT_ID_LIKE_RE.test(String(explicit))) return explicit;
  if (status === "draft" || status === "brouillon") return "Brouillon";
  return "Sans numéro";
}

function docCustomer(item: any) {
  return item?.customer_name || item?.client_name || item?.customer?.name || item?.client || "—";
}

function docTotal(item: any) {
  return item?.total_inc_vat ?? item?.total_ttc ?? item?.amount_total ?? item?.total ?? 0;
}

function docDate(item: any) {
  return (
    item?.issue_date ||
    item?.issued_at ||
    item?.emission_date ||
    item?.date ||
    item?.created_at ||
    item?.updated_at ||
    null
  );
}

function shortDate(value: any) {
  const date = parseDocumentDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit" }).format(date);
}

function shortTime(value: any) {
  const date = parseDocumentDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function parseDocumentDate(value: any) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const raw = String(value);
  const frenchDate = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(raw);
  if (frenchDate) {
    const [, day, month, year] = frenchDate;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthShort(date: Date) {
  return new Intl.DateTimeFormat("fr-FR", { month: "short" }).format(date).replace(".", "");
}

function docStatus(item: any) {
  const key = String(item?.status || "").toLowerCase();
  return statusPillMap[key] || { label: item?.status || "Inconnu", color: "muted" as const };
}

function EmptyTableRow({ cols, label = "Aucun document pour l'instant" }: { cols: number; label?: string }) {
  return (
    <tr>
      <td
        colSpan={cols}
        className="px-5 py-10 text-center text-[#64748b]"
        style={{ fontSize: "var(--pf-app-text-body)" }}
      >
        {label}
      </td>
    </tr>
  );
}

const accentPalette: Record<
  "blue" | "green" | "coral" | "cyan" | "amber" | "purple" | "red",
  { bg: string; border: string; text: string; soft: string; icon: string }
> = {
  blue: { bg: "#eff6ff", border: "#bfdbfe", text: "#1d4ed8", soft: "#dbeafe", icon: "#1d4ed8" },
  green: { bg: "#f0fdf4", border: "#bbf7d0", text: "#15803d", soft: "#dcfce7", icon: "#16a34a" },
  coral: { bg: "#fff7ed", border: "#fed7aa", text: "#c2410c", soft: "#ffedd5", icon: "#ea580c" },
  cyan: { bg: "#ecfeff", border: "#a5f3fc", text: "#0e7490", soft: "#cffafe", icon: "#0891b2" },
  amber: { bg: "#fffbeb", border: "#fde68a", text: "#b45309", soft: "#fef3c7", icon: "#d97706" },
  purple: { bg: "#f5f3ff", border: "#ddd6fe", text: "#6d28d9", soft: "#ede9fe", icon: "#7c3aed" },
  red: { bg: "#fff1f2", border: "#fecdd3", text: "#e11d48", soft: "#ffe4e6", icon: "#e11d48" },
};

type AccentKey = keyof typeof accentPalette;

type AnalysisPeriod = "weekly" | "monthly" | "quarterly" | "semester";
const DASHBOARD_ANALYSIS_PERIOD_KEY = "pixfacture.dashboard.analysisPeriod.v1";

const analysisPeriodOptions: Array<{ value: AnalysisPeriod; label: string }> = [
  { value: "weekly", label: "Hebdomadaire" },
  { value: "monthly", label: "Mensuel" },
  { value: "quarterly", label: "Trimestriel" },
  { value: "semester", label: "Semestriel" },
];

type DashboardSeriesKey = "factures" | "devis" | "encaissements" | "achats";
type DashboardChartBucket = { label: string } & Record<DashboardSeriesKey, number>;

const dashboardSeriesKeys: DashboardSeriesKey[] = ["factures", "devis", "encaissements", "achats"];

const dashboardSeriesMeta: Record<
  DashboardSeriesKey,
  { label: string; shortLabel: string; color: string; bg: string; border: string }
> = {
  factures: { label: "Factures", shortLabel: "Factures", color: "#2563eb", bg: "#eff6ff", border: "#bfdbfe" },
  devis: { label: "Devis", shortLabel: "Devis", color: "#7c3aed", bg: "#f5f3ff", border: "#ddd6fe" },
  encaissements: { label: "Paiements", shortLabel: "Paiements", color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0" },
  achats: { label: "Achats", shortLabel: "Achats", color: "#ea580c", bg: "#fff7ed", border: "#fed7aa" },
};

function isAnalysisPeriod(value: any): value is AnalysisPeriod {
  return ["weekly", "monthly", "quarterly", "semester"].includes(String(value));
}

function buildPeriodLabels() {
  const formatter = new Intl.DateTimeFormat("fr-FR", { month: "short" });
  const now = new Date();
  const currentMonth = formatter.format(now).replace(".", "");
  const previousMonth = formatter.format(new Date(now.getFullYear(), now.getMonth() - 1, 1)).replace(".", "");
  const periodStart = new Date(now.getFullYear(), now.getMonth() - 11, 1).toISOString();
  return { currentMonth, previousMonth, periodStart, periodEnd: now.toISOString() };
}

function dateParam(value: string) {
  const date = parseDocumentDate(value);
  if (!date) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function linkWithQuery(path: string, params: Record<string, string | null | undefined>) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) search.set(key, value);
  });
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

function startOfIsoWeek(date: Date) {
  const day = date.getDay() || 7;
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - day + 1);
  start.setHours(0, 0, 0, 0);
  return start;
}

function isoWeekInfo(date: Date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

function periodBucketKey(date: Date, period: AnalysisPeriod) {
  if (period === "weekly") {
    const { year, week } = isoWeekInfo(date);
    return `${year}-W${String(week).padStart(2, "0")}`;
  }
  if (period === "quarterly") {
    return `${date.getFullYear()}-Q${Math.floor(date.getMonth() / 3) + 1}`;
  }
  if (period === "semester") {
    return `${date.getFullYear()}-S${date.getMonth() < 6 ? 1 : 2}`;
  }
  return monthKey(date);
}

function periodBucketLabel(date: Date, period: AnalysisPeriod) {
  const shortYear = String(date.getFullYear()).slice(-2);
  if (period === "weekly") return `S${isoWeekInfo(date).week}`;
  if (period === "quarterly") return `T${Math.floor(date.getMonth() / 3) + 1} ${shortYear}`;
  if (period === "semester") return `S${date.getMonth() < 6 ? 1 : 2} ${shortYear}`;
  return monthShort(date);
}

function buildPeriodBuckets(period: AnalysisPeriod, periodEnd: string) {
  const end = parseDocumentDate(periodEnd) || new Date();
  const count = period === "weekly" ? 8 : period === "monthly" ? 6 : 4;
  return Array.from({ length: count }, (_, index) => {
    const offset = count - 1 - index;
    let date: Date;
    if (period === "weekly") {
      date = startOfIsoWeek(end);
      date.setDate(date.getDate() - offset * 7);
    } else if (period === "quarterly") {
      const quarterStartMonth = Math.floor(end.getMonth() / 3) * 3;
      date = new Date(end.getFullYear(), quarterStartMonth - offset * 3, 1);
    } else if (period === "semester") {
      const semesterStartMonth = end.getMonth() < 6 ? 0 : 6;
      date = new Date(end.getFullYear(), semesterStartMonth - offset * 6, 1);
    } else {
      date = new Date(end.getFullYear(), end.getMonth() - offset, 1);
    }
    return {
      key: periodBucketKey(date, period),
      label: periodBucketLabel(date, period),
    };
  });
}

function SectionHeader({
  title,
  eyebrow,
  description,
  right,
}: {
  title: string;
  eyebrow?: string;
  description?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1 text-[var(--pf-app-text-overline)] font-semibold uppercase tracking-[0.06em] text-[#64748b]">
            {eyebrow}
          </p>
        ) : null}
        <h2 className="text-[var(--pf-app-text-title)] font-semibold tracking-normal text-[#172033]">{title}</h2>
        {description ? (
          <p className="mt-1 text-[var(--pf-app-text-body)] leading-relaxed text-[#64748b]">{description}</p>
        ) : null}
      </div>
      {right ? <div className="flex flex-wrap items-center gap-2">{right}</div> : null}
    </div>
  );
}

function DashboardSurface({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border border-[#dbe4f0] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.035),0_18px_44px_-36px_rgba(15,23,42,0.58)] ${className}`}
    >
      {children}
    </div>
  );
}

function SetupGuide({
  steps,
  percent,
  primaryAction,
}: {
  steps: Array<{ key?: string; label?: string; href?: string; done?: boolean; reason?: string | null }>;
  percent: number;
  primaryAction: { label?: string; href?: string; reason?: string | null } | null;
}) {
  const visibleSteps = steps.slice(0, 4);
  return (
    <DashboardSurface className="overflow-hidden border-[#bfdbfe]">
      <div className="grid grid-cols-1 items-start gap-4 p-4 lg:grid-cols-[minmax(260px,0.55fr)_minmax(0,1fr)] lg:p-5">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-2 rounded-full bg-[#eff6ff] px-3 py-1 text-[var(--pf-app-text-caption)] font-bold text-[#1d4ed8]">
            Mise en route · {Math.max(0, Math.min(100, Math.round(percent)))}%
          </span>
          <h2 className="mt-2.5 text-[1.08rem] font-bold leading-tight text-[#0f172a]">
            Finalisez les bases avant de piloter l'activité.
          </h2>
          <p className="mt-1.5 max-w-[56ch] text-[var(--pf-app-text-body)] leading-relaxed text-[#475569]">
            Le tableau de bord devient vraiment utile dès que l'entreprise, les clients et les premiers documents sont
            en place.
          </p>
          {primaryAction?.href ? (
            <Link
              to={primaryAction.href}
              className="mt-4 inline-flex min-h-9 items-center gap-2 rounded-xl bg-[#2563eb] px-3.5 text-[var(--pf-app-text-body)] font-semibold text-white shadow-[0_10px_22px_-15px_rgba(37,99,235,0.9)] transition hover:bg-[#1d4ed8]"
            >
              {primaryAction.label || "Continuer"} <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-2 self-start sm:grid-cols-2">
          {visibleSteps.map((step, index) => {
            const done = Boolean(step.done);
            return (
              <Link
                key={step.key || `${step.label}-${index}`}
                to={step.href || "/app"}
                className={`group rounded-xl border px-3 py-2.5 transition hover:-translate-y-0.5 ${
                  done
                    ? "border-[#bbf7d0] bg-[#f0fdf4] text-[#166534]"
                    : "border-[#dbe4f0] bg-[#f8fafc] text-[#172033] hover:border-[#bfdbfe] hover:bg-[#eff6ff]"
                }`}
              >
                <span className="flex items-start gap-2">
                  <span
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                      done ? "bg-[#dcfce7] text-[#16a34a]" : "bg-white text-[#64748b]"
                    }`}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[var(--pf-app-text-body)] font-bold">
                      {step.label || "Étape"}
                    </span>
                    <span className="mt-1 line-clamp-2 block text-[var(--pf-app-text-caption)] font-medium text-[#64748b]">
                      {done ? "Terminé" : step.reason || "À compléter pour continuer."}
                    </span>
                  </span>
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </DashboardSurface>
  );
}

function ChartCard({
  title,
  value,
  right,
  children,
  className = "",
  valueLayout = "badge",
}: {
  title: string;
  value?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  valueLayout?: "badge" | "hero";
}) {
  const hero = valueLayout === "hero";
  return (
    <DashboardSurface className={`flex h-full min-w-0 flex-col overflow-hidden ${className}`}>
      <div className={`${hero ? "px-5 pt-4" : "border-b border-[#eef2f7] px-5 py-4"}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {hero ? (
            <div className="min-w-0">
              <h3 className="text-[var(--pf-app-text-overline)] font-semibold uppercase tracking-[0.06em] text-[#64748b]">
                {title}
              </h3>
              {value ? (
                <p className="mt-2.5 text-[2rem] font-bold leading-none tracking-normal text-[#0f172a]">{value}</p>
              ) : null}
            </div>
          ) : (
            <h3 className="min-w-0 truncate text-[var(--pf-app-text-body)] font-semibold text-[#172033]">{title}</h3>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {value && !hero ? (
              <span className="rounded-full border border-[#dbe4f0] bg-[#f8fafc] px-3 py-1 text-[var(--pf-app-text-caption)] font-semibold text-[#334155]">
                {value}
              </span>
            ) : null}
            {right}
          </div>
        </div>
      </div>
      <div className={hero ? "flex flex-1 flex-col px-5 pb-5 pt-3" : "flex flex-1 flex-col p-5"}>{children}</div>
    </DashboardSurface>
  );
}

function MiniTrendCard({
  title,
  value,
  data,
  accent,
  href,
  icon: Icon,
  detail,
}: {
  title: string;
  value: string;
  data: Array<{ label: string; value: number }>;
  accent: AccentKey;
  href: string;
  icon: ElementType;
  detail?: string;
}) {
  const palette = accentPalette[accent];
  const width = 720;
  const height = 210;
  const left = 26;
  const right = 26;
  const top = 16;
  const bottom = 34;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const rawValues = data.map((item) => safeNumber(item.value));
  const max = Math.max(1, ...rawValues);
  const min = Math.min(0, ...rawValues);
  const visualMax = max * 1.08;
  const span = Math.max(1, visualMax - min);
  const points = data.map((item, index) => {
    const x = data.length <= 1 ? width / 2 : left + (index / (data.length - 1)) * plotWidth;
    const y = top + (1 - (safeNumber(item.value) - min) / span) * plotHeight;
    return { x, y, label: item.label, value: safeNumber(item.value) };
  });
  const [selectedIndex, setSelectedIndex] = useState(Math.max(0, points.length - 1));
  const selectedPoint = points[selectedIndex] || points[points.length - 1];
  const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const area = points.length
    ? `M ${points.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" L ")} L ${width - right} ${
        height - bottom
      } L ${left} ${height - bottom} Z`
    : "";
  const lastPoint = points[points.length - 1];
  const peak = Math.max(...rawValues, 0);
  const selectedLabel = selectedPoint ? compactMoney(selectedPoint.value) : "";
  const selectedLabelX = selectedPoint ? Math.max(60, Math.min(width - 60, selectedPoint.x)) : 0;
  const selectedLabelY = selectedPoint ? Math.max(24, selectedPoint.y - 18) : 0;
  const previousValue = points.length > 1 ? safeNumber(points[points.length - 2]?.value) : 0;
  const currentValue = safeNumber(lastPoint?.value);
  const trendRatio = previousValue > 0 ? ((currentValue - previousValue) / previousValue) * 100 : 0;
  const trendPositive = trendRatio >= 0;
  const trendLabel =
    previousValue <= 0 && currentValue > 0
      ? "Nouveau"
      : `${trendPositive ? "↗" : "↘"} ${trendPositive ? "+" : ""}${trendRatio.toLocaleString("fr-FR", {
          maximumFractionDigits: 1,
        })}%`;

  return (
    <div
      className="group relative h-[252px] overflow-hidden rounded-2xl border border-[#dbe4f0] bg-white text-[#0f172a] shadow-[0_1px_2px_rgba(15,23,42,0.035),0_18px_40px_-34px_rgba(15,23,42,0.56)] transition hover:-translate-y-0.5"
      style={{ borderColor: palette.border }}
    >
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: palette.text }} />
      <div className="absolute right-4 top-4 z-20 flex w-[132px] max-w-[42%] flex-col items-end gap-1 text-right">
        <span
          className="whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold leading-tight"
          style={{
            background: trendPositive ? "#ecfdf5" : "#fff1f2",
            color: trendPositive ? "#059669" : "#e11d48",
          }}
        >
          {trendLabel}
        </span>
        {detail ? (
          <span
            className="max-w-full truncate rounded-full px-2 py-0.5 text-[11px] font-semibold leading-tight"
            style={{ background: palette.bg, color: palette.text }}
          >
            {detail}
          </span>
        ) : null}
      </div>
      <div className="relative z-10 px-4 pb-0 pt-4">
        <div className="flex min-w-0 max-w-[calc(100%-140px)] items-center gap-2">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
            style={{ backgroundColor: palette.bg, color: palette.icon }}
          >
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-[var(--pf-app-text-overline)] font-bold uppercase leading-tight tracking-[0.04em] text-[#334155]">
              {title}
            </h3>
          </div>
        </div>
        <p className="mt-1.5 whitespace-nowrap text-[1.5rem] font-bold leading-none tracking-normal text-[#0f172a]">
          {value}
        </p>
      </div>
      <div className="absolute inset-x-4 bottom-[38px] top-[76px] z-10 rounded-xl border border-[#e8eef7] bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] px-2 py-1">
        <svg className="h-full w-full overflow-visible" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
          <title>{`${title} interactif`}</title>
          {[0, 0.5, 1].map((ratio) => {
            const y = top + ratio * plotHeight;
            return (
              <line
                key={`grid-${title}-${ratio}`}
                stroke={ratio === 1 ? "#cbd5e1" : "#dde8f3"}
                strokeDasharray={ratio === 1 ? "0" : "4 5"}
                strokeWidth={ratio === 1 ? "2" : "1.3"}
                x1={left}
                x2={width - right}
                y1={y}
                y2={y}
              />
            );
          })}
          <path d={area} fill={palette.soft} opacity="0.72" />
          {selectedPoint ? (
            <line
              stroke={palette.border}
              strokeDasharray="4 4"
              strokeWidth="1.4"
              x1={selectedPoint.x}
              x2={selectedPoint.x}
              y1={top - 4}
              y2={height - bottom}
            />
          ) : null}
          <polyline fill="none" points={line} stroke={palette.icon} strokeLinecap="round" strokeWidth="7.2" />
          {selectedPoint ? (
            <g className="pointer-events-none">
              <rect
                fill="white"
                height="38"
                rx="19"
                stroke={palette.border}
                strokeWidth="1.4"
                width="158"
                x={selectedLabelX - 79}
                y={selectedLabelY - 29}
              />
              <text
                fill={palette.text}
                fontSize="22"
                fontWeight="800"
                textAnchor="middle"
                x={selectedLabelX}
                y={selectedLabelY - 4}
              >
                {selectedLabel}
              </text>
            </g>
          ) : null}
          {points.map((point, index) => {
            const band = points.length <= 1 ? width : width / Math.max(1, points.length - 1);
            const hitWidth = Math.min(130, Math.max(58, band));
            return (
              <rect
                key={`hit-${title}-${point.label}`}
                role="button"
                tabIndex={0}
                aria-label={`${title} ${point.label}: ${money(point.value)}`}
                className="cursor-pointer outline-none"
                fill="transparent"
                height={plotHeight + 24}
                width={hitWidth}
                x={Math.max(left - 14, Math.min(width - right - hitWidth + 14, point.x - hitWidth / 2))}
                y={Math.max(0, top - 10)}
                onClick={() => setSelectedIndex(index)}
                onFocus={() => setSelectedIndex(index)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedIndex(index);
                  }
                }}
              />
            );
          })}
          {points.map((point, index) => (
            <g
              key={`${title}-${point.label}`}
              role="button"
              tabIndex={0}
              aria-label={`${title} ${point.label}: ${money(point.value)}`}
              className="cursor-pointer outline-none"
              onClick={() => setSelectedIndex(index)}
              onFocus={() => setSelectedIndex(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedIndex(index);
                }
              }}
            >
              <circle
                cx={point.x}
                cy={point.y}
                fill={selectedIndex === index ? palette.icon : "white"}
                r={selectedIndex === index ? "10.5" : "7.4"}
                stroke={palette.icon}
                strokeWidth="3.4"
              />
              <circle cx={point.x} cy={point.y} fill="transparent" r="26" />
            </g>
          ))}
          {points.map((point, index) =>
            index === 0 || index === points.length - 1 || index === Math.floor(points.length / 2) ? (
              <text
                key={`label-${title}-${point.label}`}
                fill="#64748b"
                fontSize="16"
                fontWeight="700"
                textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
                x={point.x}
                y={height - 7}
              >
                {point.label}
              </text>
            ) : null,
          )}
        </svg>
      </div>
      <div className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 border-t border-[#eef2f7] bg-white/90 px-4 py-2 text-[var(--pf-app-text-caption)] font-bold text-[#334155] backdrop-blur-sm">
        <span className="min-w-0 truncate">
          {selectedPoint
            ? `${selectedPoint.label}: ${compactMoney(selectedPoint.value)} · ${pluralFr(data.length, "période")}`
            : `Pic ${compactMoney(peak)}`}
        </span>
        <Link
          to={href}
          aria-label={`Ouvrir ${title}`}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#f8fafc] text-[#64748b] transition group-hover:bg-white group-hover:text-[#1d4ed8]"
        >
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

function MonthlyFlowChart({
  data,
  activeSeries,
  availableSeries,
  onToggleSeries,
}: {
  data: DashboardChartBucket[];
  activeSeries: Record<DashboardSeriesKey, boolean>;
  availableSeries: DashboardSeriesKey[];
  onToggleSeries: (key: DashboardSeriesKey) => void;
}) {
  const width = 1280;
  const height = 340;
  const left = 70;
  const right = 34;
  const top = 24;
  const bottom = 48;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const visibleKeys = availableSeries.filter((key) => activeSeries[key]);
  const globalMax = Math.max(1, ...data.flatMap((item) => visibleKeys.map((key) => safeNumber(item[key]))));
  const relativeScale = visibleKeys.length > 1;
  const seriesMax = Object.fromEntries(
    visibleKeys.map((key) => [key, Math.max(1, ...data.map((item) => safeNumber(item[key])))]),
  ) as Record<DashboardSeriesKey, number>;
  const hasValues = data.some((item) => visibleKeys.some((key) => safeNumber(item[key]) > 0));
  const visibleTotal = data.reduce(
    (sum, item) => sum + visibleKeys.reduce((seriesSum, key) => seriesSum + safeNumber(item[key]), 0),
    0,
  );
  const toPoints = (key: DashboardSeriesKey) =>
    data.map((item, index) => {
      const x = data.length <= 1 ? left + plotWidth / 2 : left + (index / (data.length - 1)) * plotWidth;
      const value = safeNumber(item[key]);
      const y = top + plotHeight - (value / (relativeScale ? seriesMax[key] : globalMax)) * plotHeight;
      return { x, y, value, label: item.label };
    });
  const pointsToLine = (points: Array<{ x: number; y: number }>) =>
    points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const pointsToArea = (points: Array<{ x: number; y: number }>) =>
    `M ${points.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" L ")} L ${width - right} ${
      height - bottom
    } L ${left} ${height - bottom} Z`;
  const seriesPoints = visibleKeys.map((key) => ({ key, points: toPoints(key), meta: dashboardSeriesMeta[key] }));

  return (
    <div className="min-w-0">
      <svg className="h-[390px] w-full overflow-visible" role="img" viewBox={`0 0 ${width} ${height}`}>
        <title>Évolution de l'activité par type de flux</title>
        <defs>
          {availableSeries.map((key) => (
            <linearGradient key={key} id={`pfDashboardSeries-${key}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={dashboardSeriesMeta[key].color} stopOpacity="0.2" />
              <stop offset="100%" stopColor={dashboardSeriesMeta[key].color} stopOpacity="0.02" />
            </linearGradient>
          ))}
        </defs>
        {[0, 0.5, 1].map((ratio) => {
          const y = top + ratio * plotHeight;
          const value = globalMax - globalMax * ratio;
          return (
            <g key={`axis-${ratio}`}>
              <text fill="#94a3b8" fontSize="12" fontWeight="700" textAnchor="end" x={left - 12} y={y + 4}>
                {relativeScale ? (ratio === 0 ? "Max" : ratio === 0.5 ? "50%" : "0") : compactMoney(value)}
              </text>
              <line stroke="#e5edf7" strokeDasharray="4 6" x1={left} x2={width - right} y1={y} y2={y} />
            </g>
          );
        })}
        {hasValues
          ? seriesPoints.map((series) => (
              <path
                key={`area-${series.key}`}
                d={pointsToArea(series.points)}
                fill={`url(#pfDashboardSeries-${series.key})`}
                opacity="0.72"
              />
            ))
          : null}
        {seriesPoints.map((series) => (
          <polyline
            key={`line-${series.key}`}
            fill="none"
            points={pointsToLine(series.points)}
            stroke={series.meta.color}
            strokeLinecap="round"
            strokeWidth="3.2"
          />
        ))}
        {!hasValues ? (
          <text
            fill="#64748b"
            fontSize="15"
            fontWeight="700"
            textAnchor="middle"
            x={left + plotWidth / 2}
            y={top + plotHeight / 2}
          >
            Pas assez de données pour afficher une tendance fiable.
          </text>
        ) : null}
        {seriesPoints.flatMap((series) =>
          series.points.map((point) => (
            <g key={`${series.key}-${point.label}`} className="pointer-events-none">
              <circle cx={point.x} cy={point.y} fill="#fff" r="4.8" stroke={series.meta.color} strokeWidth="2" />
            </g>
          )),
        )}
        {data.map((item, index) => {
          const x = data.length <= 1 ? left + plotWidth / 2 : left + (index / (data.length - 1)) * plotWidth;
          return (
            <text
              key={item.label}
              fill="#94a3b8"
              fontSize="12"
              fontWeight="600"
              textAnchor="middle"
              x={x}
              y={height - 8}
            >
              {item.label}
            </text>
          );
        })}
      </svg>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-[var(--pf-app-text-caption)] font-semibold text-[#64748b]">
        <AnalysisSeriesControl
          activeSeries={activeSeries}
          availableSeries={availableSeries}
          onToggle={onToggleSeries}
        />
        <span className="ml-auto font-semibold text-[#172033]">Total affiché : {compactMoney(visibleTotal)}</span>
        {relativeScale ? (
          <span className="rounded-full bg-[#f8fafc] px-2 py-0.5 text-[#64748b]">
            Échelle relative · montants réels ci-dessous
          </span>
        ) : null}
      </div>
    </div>
  );
}

function OperationalActionCard({
  label,
  value,
  detail,
  href,
  icon: Icon,
  accent,
  badge,
  badgeColor = "info",
  actionLabel = "Ouvrir",
}: {
  label: string;
  value: string;
  detail: string;
  href: string;
  icon: ElementType;
  accent: AccentKey;
  badge?: string;
  badgeColor?: "ok" | "warn" | "danger" | "muted" | "info" | "purple";
  actionLabel?: string;
}) {
  const palette = accentPalette[accent];
  return (
    <Link
      to={href}
      title={detail}
      className="group relative flex min-h-[172px] min-w-0 flex-col justify-between gap-4 overflow-hidden rounded-2xl border border-[#dbe4f0] bg-white px-5 py-4 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_18px_40px_-34px_rgba(15,23,42,0.58)] outline-none transition hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-[#2563eb]/30"
    >
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: palette.text }} />
      <span className="flex min-w-0 items-start justify-between gap-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
          style={{ background: palette.bg, color: palette.icon }}
        >
          <Icon className="h-4 w-4" />
        </span>
        {badge ? <StatusPill label={badge} color={badgeColor} /> : null}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[var(--pf-app-text-body)] font-bold text-[#0f172a]">{label}</span>
        <strong className="mt-2 block text-[1.24rem] font-extrabold leading-tight tracking-normal text-[#0f172a]">
          {value}
        </strong>
        <span className="mt-1.5 line-clamp-2 block text-[var(--pf-app-text-caption)] font-semibold leading-snug text-[#64748b]">
          {detail}
        </span>
      </span>
      <span
        className="inline-flex min-h-8 w-fit items-center gap-1 rounded-lg px-2.5 text-[var(--pf-app-text-caption)] font-bold transition-transform group-hover:translate-x-0.5"
        style={{ color: palette.text, background: palette.bg }}
      >
        {actionLabel} <ArrowRight className="h-3.5 w-3.5 shrink-0" />
      </span>
    </Link>
  );
}

function countVatAnomalies(vatSummary: any) {
  const anomalies = Array.isArray(vatSummary?.anomalies) ? vatSummary.anomalies : [];
  return anomalies.reduce((sum: number, item: any) => sum + safeNumber(item?.count), 0);
}

function firstVatAction(vatSummary: any) {
  const anomalies = Array.isArray(vatSummary?.anomalies) ? vatSummary.anomalies : [];
  return anomalies.find((item: any) => item?.action?.href)?.action || null;
}

function amountForStatus(items: any[], statuses: string[]) {
  const accepted = new Set(statuses);
  return items
    .filter((item) => accepted.has(String(item?.status || "").toLowerCase()))
    .reduce((sum, item) => sum + safeNumber(docTotal(item)), 0);
}

function isAcceptedQuoteReadyToInvoice(item: any) {
  if (String(item?.status || "").toLowerCase() !== "accepted") return false;
  const invoiceId =
    item?.invoice_id || item?.invoiceId || item?.converted_invoice_id || item?.existing_invoice_id || null;
  return !invoiceId;
}

function amountForAcceptedQuotesReadyToInvoice(items: any[]) {
  return items.filter(isAcceptedQuoteReadyToInvoice).reduce((sum, item) => sum + safeNumber(docTotal(item)), 0);
}

function AnalysisPeriodControl({
  value,
  onChange,
}: {
  value: AnalysisPeriod;
  onChange: (value: AnalysisPeriod) => void;
}) {
  return (
    <div
      className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-xl border border-[#dbe4f0] bg-[#f8fafc] p-1 shadow-sm"
      aria-label="Période d'analyse"
      role="group"
    >
      {analysisPeriodOptions.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`rounded-lg border px-2.5 py-1.5 text-[var(--pf-app-text-caption)] font-bold transition ${
              active
                ? "border-[#93c5fd] bg-[#dbeafe] text-[#1d4ed8] shadow-sm"
                : "border-transparent bg-white text-[#334155] hover:border-[#bfdbfe] hover:bg-[#eff6ff] hover:text-[#1d4ed8]"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function AnalysisSeriesControl({
  activeSeries,
  availableSeries,
  onToggle,
}: {
  activeSeries: Record<DashboardSeriesKey, boolean>;
  availableSeries: DashboardSeriesKey[];
  onToggle: (key: DashboardSeriesKey) => void;
}) {
  return (
    <div
      className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-xl border border-[#dbe4f0] bg-[#f8fafc] p-1.5 shadow-sm"
      aria-label="Indicateurs affichés"
      role="group"
    >
      {availableSeries.map((key) => {
        const active = activeSeries[key];
        const meta = dashboardSeriesMeta[key];
        return (
          <label
            key={key}
            className="inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-lg border px-2.5 text-[var(--pf-app-text-caption)] font-bold transition hover:border-[#bfdbfe] hover:bg-[#eff6ff]"
            style={{
              borderColor: active ? meta.border : "#e2e8f0",
              background: active ? meta.bg : "#ffffff",
              color: active ? meta.color : "#334155",
            }}
          >
            <input
              type="checkbox"
              checked={active}
              onChange={() => onToggle(key)}
              className="h-3.5 w-3.5 rounded border-[#cbd5e1]"
              style={{ accentColor: meta.color }}
            />
            <span className="h-2 w-2 rounded-full" style={{ background: meta.color }} />
            {meta.shortLabel}
          </label>
        );
      })}
    </div>
  );
}

function buildPeriodFlowData({
  invoices,
  quotes,
  periodEnd,
  period,
}: {
  invoices: any[];
  quotes: any[];
  periodEnd: string;
  period: AnalysisPeriod;
}) {
  const buckets = buildPeriodBuckets(period, periodEnd).map((bucket) => ({
    ...bucket,
    factures: 0,
    devis: 0,
  }));
  const bucketMap = new Map(buckets.map((bucket) => [bucket.key, bucket]));

  invoices.forEach((invoice) => {
    const status = String(invoice?.status || "").toLowerCase();
    if (status === "draft" || status === "canceled") return;
    const date = parseDocumentDate(docDate(invoice));
    if (!date) return;
    const bucket = bucketMap.get(periodBucketKey(date, period));
    if (bucket) bucket.factures += safeNumber(docTotal(invoice));
  });

  quotes.forEach((quote) => {
    const status = String(quote?.status || "").toLowerCase();
    if (status === "rejected" || status === "expired" || status === "canceled") return;
    const date = parseDocumentDate(docDate(quote));
    if (!date) return;
    const bucket = bucketMap.get(periodBucketKey(date, period));
    if (bucket) bucket.devis += safeNumber(docTotal(quote));
  });

  return buckets;
}

function buildPeriodAmountSeries({
  invoices,
  periodEnd,
  period,
  filter,
  value,
}: {
  invoices: any[];
  periodEnd: string;
  period: AnalysisPeriod;
  filter: (invoice: any) => boolean;
  value: (invoice: any) => number;
}) {
  const buckets = buildPeriodBuckets(period, periodEnd).map((bucket) => ({
    ...bucket,
    value: 0,
  }));
  const bucketMap = new Map(buckets.map((bucket) => [bucket.key, bucket]));

  invoices.forEach((invoice) => {
    if (!filter(invoice)) return;
    const date = parseDocumentDate(docDate(invoice));
    if (!date) return;
    const bucket = bucketMap.get(periodBucketKey(date, period));
    if (bucket) bucket.value += value(invoice);
  });

  return buckets.map(({ label, value: amount }) => ({ label, value: amount }));
}

function buildItemAmountSeries({
  items,
  periodEnd,
  period,
  date,
  value,
}: {
  items: any[];
  periodEnd: string;
  period: AnalysisPeriod;
  date: (item: any) => any;
  value: (item: any) => number;
}) {
  const buckets = buildPeriodBuckets(period, periodEnd).map((bucket) => ({
    ...bucket,
    value: 0,
  }));
  const bucketMap = new Map(buckets.map((bucket) => [bucket.key, bucket]));

  items.forEach((item) => {
    const itemDate = parseDocumentDate(date(item));
    if (!itemDate) return;
    const bucket = bucketMap.get(periodBucketKey(itemDate, period));
    if (bucket) bucket.value += value(item);
  });

  return buckets.map(({ label, value: amount }) => ({ label, value: amount }));
}

function countByStatus(items: any[], statuses: string[]) {
  const accepted = new Set(statuses);
  return items.filter((item) => accepted.has(String(item?.status || "").toLowerCase())).length;
}

function aggregatePeriodRows(aggregate: any, period: AnalysisPeriod) {
  const rows = aggregate?.periods?.[period];
  return Array.isArray(rows) ? rows : null;
}

function aggregateFlowRows(aggregate: any, period: AnalysisPeriod) {
  const rows = aggregatePeriodRows(aggregate, period);
  if (!rows) return null;
  return rows.map((item: any) => ({
    key: item?.key,
    label: item?.label || "—",
    factures: safeNumber(item?.factures),
    devis: safeNumber(item?.devis),
  }));
}

function aggregateAmountRows(aggregate: any, period: AnalysisPeriod, field: "factures" | "devis" | "encaissements") {
  const rows = aggregatePeriodRows(aggregate, period);
  if (!rows) return null;
  return rows.map((item: any) => ({
    label: item?.label || "—",
    value: safeNumber(item?.[field]),
  }));
}

function FinanceCell({
  label,
  value,
  detail,
  accent,
  href,
}: {
  label: string;
  value: string;
  detail: string;
  accent: AccentKey;
  href: string;
}) {
  const palette = accentPalette[accent];
  return (
    <Link
      to={href}
      className="group min-h-[92px] rounded-2xl border border-[#dbe4f0] bg-white px-4 py-3.5 shadow-sm transition hover:-translate-y-0.5 hover:border-[#cbd5e1] hover:shadow-md"
    >
      <p className="text-[var(--pf-app-text-overline)] font-bold uppercase tracking-[0.05em] text-[#64748b]">{label}</p>
      <p className="mt-2 text-[1.2rem] font-extrabold leading-none tracking-normal" style={{ color: palette.text }}>
        {value}
      </p>
      <p className="mt-2 flex items-center gap-1 text-[var(--pf-app-text-caption)] font-semibold text-[#172033]">
        {detail}
        <ArrowRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
      </p>
    </Link>
  );
}

function RecentDocumentsPanel({
  title,
  href,
  rows,
  loading,
  emptyLabel,
  createHref,
  createLabel,
  accent,
  type,
}: {
  title: string;
  href: string;
  rows: any[];
  loading: boolean;
  emptyLabel: string;
  createHref: string;
  createLabel: string;
  accent: AccentKey;
  type: "quote" | "invoice";
}) {
  const palette = accentPalette[accent];
  const Icon = type === "quote" ? Send : FileText;
  return (
    <DashboardSurface className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[#eef2f7] px-5 py-4">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl"
            style={{ background: palette.soft, color: palette.icon }}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
          <h3 className="min-w-0 text-[var(--pf-app-text-body)] font-semibold text-[#172033]">{title}</h3>
        </div>
        <Link
          to={href}
          className="inline-flex items-center gap-1 text-[var(--pf-app-text-caption)] font-semibold text-[#1d4ed8]"
        >
          Voir tout <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="divide-y divide-[#eef2f7] sm:hidden">
        {loading ? (
          <div className="px-5 py-8 text-center text-[var(--pf-app-text-body)] font-medium text-[#64748b]">
            {emptyLabel}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-5 py-8 text-center text-[var(--pf-app-text-body)] font-medium text-[#64748b]">
            Aucun document pour l'instant
          </div>
        ) : (
          rows.slice(0, 4).map((item: any) => (
            <Link
              key={item.id}
              to={type === "quote" ? `/app/quotes/${item.id}` : `/app/invoices/${item.id}`}
              className="block px-5 py-4 transition hover:bg-[#fbfdff]"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span
                    className="block truncate font-mono text-[var(--pf-app-text-body)] font-bold"
                    style={{ color: String(item.status || "").toLowerCase() === "draft" ? "#64748b" : palette.text }}
                  >
                    {docNumber(item)}
                  </span>
                  <span className="mt-1 block truncate text-[var(--pf-app-text-caption)] font-semibold text-[#475569]">
                    {docCustomer(item)} · {shortDate(docDate(item))}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-[var(--pf-app-text-body)] font-bold text-[#172033]">
                    {money(docTotal(item))}
                  </span>
                  <span className="mt-1 inline-flex">
                    <StatusPill {...docStatus(item)} />
                  </span>
                </span>
              </div>
            </Link>
          ))
        )}
      </div>
      <div
        className="hidden overflow-x-auto sm:block"
        role="region"
        aria-label={type === "quote" ? "Derniers devis, tableau défilable" : "Dernières factures, tableau défilable"}
        tabIndex={0}
      >
        <table className="pf-data-table w-full min-w-[640px]">
          <thead>
            <tr className="border-b border-[#f1f5f9] bg-[#fafbfd]">
              {["Numéro", "Client", "Statut", "Date", "TTC"].map((h) => (
                <th
                  key={h}
                  className={`px-5 py-3 text-[var(--pf-app-text-overline)] font-bold uppercase tracking-[0.05em] text-[#64748b] ${
                    h === "TTC" ? "text-right" : "text-left"
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <EmptyTableRow cols={5} label={emptyLabel} />
            ) : rows.length === 0 ? (
              <EmptyTableRow cols={5} />
            ) : (
              rows.slice(0, 4).map((item: any) => (
                <tr key={item.id} className="border-b border-[#f8f9fd] last:border-b-0 hover:bg-[#fbfdff]">
                  <td className="w-[210px] max-w-[240px] px-5 py-3.5">
                    <Link
                      to={type === "quote" ? `/app/quotes/${item.id}` : `/app/invoices/${item.id}`}
                      className="block truncate font-mono text-[var(--pf-app-text-body)] font-semibold"
                      style={{ color: String(item.status || "").toLowerCase() === "draft" ? "#64748b" : palette.text }}
                      title={docNumber(item)}
                    >
                      {docNumber(item)}
                    </Link>
                  </td>
                  <td className="max-w-[180px] truncate px-5 py-3.5 text-[var(--pf-app-text-body)] font-medium text-[#475569]">
                    {docCustomer(item)}
                  </td>
                  <td className="px-5 py-3.5">
                    <StatusPill {...docStatus(item)} />
                  </td>
                  <td className="whitespace-nowrap px-5 py-3.5 text-[var(--pf-app-text-body)] font-medium text-[#64748b]">
                    {shortDate(docDate(item))}
                  </td>
                  <td className="px-5 py-3.5 text-right text-[var(--pf-app-text-body)] font-semibold text-[#172033]">
                    {money(docTotal(item))}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {!loading && rows.length === 0 ? (
        <div className="border-t border-[#f1f5f9] px-5 py-4">
          <Link
            to={createHref}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[var(--pf-app-text-caption)] font-semibold transition-colors"
            style={{ background: palette.bg, color: palette.text }}
          >
            <Plus className="h-3.5 w-3.5" /> {createLabel}
          </Link>
        </div>
      ) : null}
    </DashboardSurface>
  );
}

function RecentPaymentsPanel({ rows, loading, className = "" }: { rows: any[]; loading: boolean; className?: string }) {
  return (
    <DashboardSurface className={`overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-[#eef2f7] px-5 py-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-[#dcfce7] text-[#16a34a]">
            <Wallet className="h-3.5 w-3.5" />
          </span>
          <h3 className="min-w-0 text-[var(--pf-app-text-body)] font-semibold text-[#172033]">Derniers paiements</h3>
        </div>
        <Link
          to="/app/cash"
          className="inline-flex items-center gap-1 text-[var(--pf-app-text-caption)] font-semibold text-[#1d4ed8]"
        >
          Voir tout <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="divide-y divide-[#eef2f7] sm:hidden">
        {loading ? (
          <div className="px-5 py-8 text-center text-[var(--pf-app-text-body)] font-medium text-[#64748b]">
            Chargement des paiements…
          </div>
        ) : rows.length === 0 ? (
          <div className="px-5 py-8 text-center text-[var(--pf-app-text-body)] font-medium text-[#64748b]">
            Aucun paiement récent
          </div>
        ) : (
          rows.slice(0, 4).map((payment: any) => (
            <Link
              key={payment.payment_id || payment.id}
              to={payment.invoice_id ? `/app/invoices/${payment.invoice_id}` : "/app/cash"}
              className="block px-5 py-4 transition hover:bg-[#fbfdff]"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[var(--pf-app-text-body)] font-bold text-[#16a34a]">
                    {payment.invoice_number || "Facture"}
                  </span>
                  <span className="mt-1 block truncate text-[var(--pf-app-text-caption)] font-semibold text-[#475569]">
                    {payment.customer_name || "—"} · {shortDate(payment.date)}
                  </span>
                </span>
                <span className="shrink-0 text-[var(--pf-app-text-body)] font-bold text-[#172033]">
                  {money(payment.amount)}
                </span>
              </div>
            </Link>
          ))
        )}
      </div>
      <div
        className="hidden overflow-x-auto sm:block"
        role="region"
        aria-label="Derniers paiements, tableau défilable"
        tabIndex={0}
      >
        <table className="pf-data-table w-full min-w-[560px]">
          <thead>
            <tr className="border-b border-[#f1f5f9] bg-[#fafbfd]">
              {["Facture", "Client", "Date", "Montant"].map((h) => (
                <th
                  key={h}
                  className="px-5 py-3 text-left text-[var(--pf-app-text-overline)] font-bold uppercase tracking-[0.05em] text-[#64748b]"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <EmptyTableRow cols={4} label="Chargement des paiements…" />
            ) : rows.length === 0 ? (
              <EmptyTableRow cols={4} label="Aucun paiement récent" />
            ) : (
              rows.slice(0, 4).map((payment: any) => (
                <tr
                  key={payment.payment_id || payment.id}
                  className="border-b border-[#f8f9fd] last:border-b-0 hover:bg-[#fbfdff]"
                >
                  <td className="w-[180px] max-w-[220px] px-5 py-3.5">
                    <Link
                      to={payment.invoice_id ? `/app/invoices/${payment.invoice_id}` : "/app/cash"}
                      className="block truncate font-mono text-[var(--pf-app-text-body)] font-semibold text-[#16a34a]"
                      title={payment.invoice_number || payment.invoice_id}
                    >
                      {payment.invoice_number || "Facture"}
                    </Link>
                  </td>
                  <td className="max-w-[180px] truncate px-5 py-3.5 text-[var(--pf-app-text-body)] font-medium text-[#475569]">
                    {payment.customer_name || "—"}
                  </td>
                  <td className="px-5 py-3.5 text-[var(--pf-app-text-body)] font-medium text-[#64748b]">
                    {shortDate(payment.date)}
                  </td>
                  <td className="px-5 py-3.5 text-right text-[var(--pf-app-text-body)] font-semibold text-[#172033]">
                    {money(payment.amount)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </DashboardSurface>
  );
}

export function DashboardPage() {
  const hydrated = useHydrated();
  const { user, loading: sessionLoading, capabilities } = useSession();
  const {
    summary,
    loading: summaryLoading,
    error: summaryError,
    reload: reloadSummary,
  } = useWorkspaceSummary({ auto: Boolean(user) });
  const [quotes, setQuotes] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [metrics, setMetrics] = useState<any>(null);
  const [collections, setCollections] = useState<any>(null);
  const [cash, setCash] = useState<any>(null);
  const [purchaseSummary, setPurchaseSummary] = useState<any>(null);
  const [purchaseWorkflow, setPurchaseWorkflow] = useState<any>(null);
  const [vatSummary, setVatSummary] = useState<any>(null);
  const [accountingSummary, setAccountingSummary] = useState<any>(null);
  const [acceptedQuotesSummary, setAcceptedQuotesSummary] = useState<any>(null);
  const [dashboardAggregate, setDashboardAggregate] = useState<any>(null);
  const [quotesLoading, setQuotesLoading] = useState(true);
  const [invoicesLoading, setInvoicesLoading] = useState(true);
  const [supportLoading, setSupportLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [analysisPeriod, setAnalysisPeriod] = useState<AnalysisPeriod>(() => {
    if (typeof window === "undefined") return "monthly";
    const stored = window.localStorage.getItem(DASHBOARD_ANALYSIS_PERIOD_KEY);
    return isAnalysisPeriod(stored) ? stored : "monthly";
  });
  const [activeAnalysisSeries, setActiveAnalysisSeries] = useState<Record<DashboardSeriesKey, boolean>>({
    factures: true,
    devis: true,
    encaissements: false,
    achats: false,
  });
  const purchasesEnabled = Boolean(capabilities?.purchases_enabled);
  const paymentsEnabled = Boolean(capabilities?.payments_enabled);
  const availableAnalysisSeries = dashboardSeriesKeys.filter(
    (key) => (key !== "achats" || purchasesEnabled) && (key !== "encaissements" || paymentsEnabled),
  );

  const toggleAnalysisSeries = (key: DashboardSeriesKey) => {
    setActiveAnalysisSeries((current) => {
      const activeCount = availableAnalysisSeries.filter((seriesKey) => current[seriesKey]).length;
      if (current[key] && activeCount <= 1) return current;
      return { ...current, [key]: !current[key] };
    });
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(DASHBOARD_ANALYSIS_PERIOD_KEY, analysisPeriod);
  }, [analysisPeriod]);

  useEffect(() => {
    let cancelled = false;

    if (sessionLoading) {
      return () => {
        cancelled = true;
      };
    }

    if (!user) {
      setQuotes([]);
      setInvoices([]);
      setMetrics(null);
      setCollections(null);
      setCash(null);
      setPurchaseSummary(null);
      setPurchaseWorkflow(null);
      setVatSummary(null);
      setAccountingSummary(null);
      setAcceptedQuotesSummary(null);
      setDashboardAggregate(null);
      setError(null);
      setQuotesLoading(false);
      setInvoicesLoading(false);
      setSupportLoading(false);
      return () => {
        cancelled = true;
      };
    }

    const load = async () => {
      setQuotesLoading(true);
      setInvoicesLoading(true);
      setSupportLoading(true);
      setError(null);
      let dashboardAggregatePayload: any = null;
      try {
        const dashboardAggregateRes = await rawApi("/api/cockpit/dashboard");
        if (!cancelled && dashboardAggregateRes.ok) {
          dashboardAggregatePayload = await dashboardAggregateRes.json().catch(() => null);
          setDashboardAggregate(dashboardAggregatePayload);
          if (dashboardAggregatePayload?.accepted_quotes) {
            setAcceptedQuotesSummary(dashboardAggregatePayload.accepted_quotes);
          } else {
            setAcceptedQuotesSummary(null);
          }
          if (Array.isArray(dashboardAggregatePayload?.recent_quotes)) {
            setQuotes(dashboardAggregatePayload.recent_quotes);
            setQuotesLoading(false);
          }
          if (Array.isArray(dashboardAggregatePayload?.recent_invoices)) {
            setInvoices(dashboardAggregatePayload.recent_invoices);
            setInvoicesLoading(false);
          }
        } else if (!cancelled) {
          setDashboardAggregate(null);
          setAcceptedQuotesSummary(null);
        }
      } catch (err) {
        if (!cancelled && process.env.NODE_ENV === "development") {
          console.warn("[dashboard] aggregate unavailable", err);
        }
        if (!cancelled) {
          setDashboardAggregate(null);
          setAcceptedQuotesSummary(null);
        }
      }
      if (cancelled) return;

      const needsQuotesFallback = !Array.isArray(dashboardAggregatePayload?.recent_quotes);
      const needsInvoicesFallback = !Array.isArray(dashboardAggregatePayload?.recent_invoices);
      const quotesPromise = needsQuotesFallback ? rawApi("/api/quotes?limit=200&offset=0") : null;
      const invoicesPromise = needsInvoicesFallback ? rawApi("/api/invoices?limit=200&offset=0") : null;
      const metricsPromise = rawApi("/api/invoices/metrics");
      const collectionsPromise = paymentsEnabled ? rawApi("/api/collections/dashboard") : Promise.resolve(null);
      const cashPromise = paymentsEnabled ? rawApi("/api/collections/cash-dashboard") : Promise.resolve(null);
      const purchaseSummaryPromise = purchasesEnabled
        ? rawApi("/api/inbox/summary?page=1&page_size=1")
        : Promise.resolve(null);
      const purchaseWorkflowPromise = purchasesEnabled
        ? rawApi("/api/ops/purchase-workflow-summary")
        : Promise.resolve(null);
      const vatSummaryPromise = purchasesEnabled
        ? rawApi("/api/cockpit/vat?include_documents=false")
        : Promise.resolve(null);
      const accountingSummaryPromise = rawApi("/api/exports/accounting/chart-summary");

      const outcomes = {
        quotes: false,
        invoices: false,
        metrics: false,
        collections: !paymentsEnabled,
        cash: !paymentsEnabled,
      };

      try {
        if (!quotesPromise) {
          outcomes.quotes = true;
        } else {
          const quotesRes = await quotesPromise;
          if (!cancelled) {
            if (quotesRes.ok) {
              const payload = await quotesRes.json().catch(() => []);
              setQuotes(Array.isArray(payload) ? payload : []);
              outcomes.quotes = true;
            } else {
              setQuotes([]);
            }
          }
        }
      } catch (err) {
        if (!cancelled && process.env.NODE_ENV === "development") {
          console.warn("[dashboard] quotes unavailable", err);
        }
        if (!cancelled) setQuotes([]);
      } finally {
        if (!cancelled) setQuotesLoading(false);
      }

      try {
        if (!invoicesPromise) {
          outcomes.invoices = true;
        } else {
          const invoicesRes = await invoicesPromise;
          if (!cancelled) {
            if (invoicesRes.ok) {
              const payload = await invoicesRes.json().catch(() => []);
              setInvoices(Array.isArray(payload) ? payload : []);
              outcomes.invoices = true;
            } else {
              setInvoices([]);
            }
          }
        }
      } catch (err) {
        if (!cancelled && process.env.NODE_ENV === "development") {
          console.warn("[dashboard] invoices unavailable", err);
        }
        if (!cancelled) setInvoices([]);
      } finally {
        if (!cancelled) setInvoicesLoading(false);
      }

      const supportResults = await Promise.allSettled([
        metricsPromise,
        collectionsPromise,
        cashPromise,
        purchaseSummaryPromise,
        purchaseWorkflowPromise,
        vatSummaryPromise,
        accountingSummaryPromise,
      ]);
      if (cancelled) return;

      const [
        metricsRes,
        collectionsRes,
        cashRes,
        purchaseSummaryRes,
        purchaseWorkflowRes,
        vatSummaryRes,
        accountingSummaryRes,
      ] = supportResults;
      if (metricsRes.status === "fulfilled" && metricsRes.value.ok) {
        setMetrics(await metricsRes.value.json().catch(() => null));
        outcomes.metrics = true;
      } else {
        setMetrics(null);
      }

      if (collectionsRes.status === "fulfilled" && collectionsRes.value?.ok) {
        setCollections(await collectionsRes.value.json().catch(() => null));
        outcomes.collections = true;
      } else {
        setCollections(null);
      }

      if (cashRes.status === "fulfilled" && cashRes.value?.ok) {
        setCash(await cashRes.value.json().catch(() => null));
        outcomes.cash = true;
      } else {
        setCash(null);
      }

      if (purchaseSummaryRes.status === "fulfilled" && purchaseSummaryRes.value?.ok) {
        setPurchaseSummary(await purchaseSummaryRes.value.json().catch(() => null));
      } else {
        setPurchaseSummary(null);
      }

      if (purchaseWorkflowRes.status === "fulfilled" && purchaseWorkflowRes.value?.ok) {
        setPurchaseWorkflow(await purchaseWorkflowRes.value.json().catch(() => null));
      } else {
        setPurchaseWorkflow(null);
      }

      if (vatSummaryRes.status === "fulfilled" && vatSummaryRes.value?.ok) {
        setVatSummary(await vatSummaryRes.value.json().catch(() => null));
      } else {
        setVatSummary(null);
      }

      if (accountingSummaryRes.status === "fulfilled" && accountingSummaryRes.value.ok) {
        setAccountingSummary(await accountingSummaryRes.value.json().catch(() => null));
      } else {
        setAccountingSummary(null);
      }

      const successCount = Object.values(outcomes).filter(Boolean).length;
      if (successCount === 0) {
        setError("Impossible de charger le tableau de bord pour le moment.");
      } else if (Object.values(outcomes).some((value) => !value)) {
        setError((current) => current || "Certaines données du tableau de bord restent indisponibles.");
      }

      setSupportLoading(false);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [user, sessionLoading, refreshNonce, purchasesEnabled, paymentsEnabled]);

  const openBalance = Number(collections?.summary?.open_balance_due ?? metrics?.open_balance_due ?? 0);
  const paidLast30Days = Number(cash?.collected_last_30_days ?? metrics?.paid_month ?? 0);
  const overdueCount = Number(
    collections?.summary?.overdue_count ?? metrics?.overdue_count ?? summary?.invoices?.overdue_count ?? 0,
  );
  const purchaseTotals = purchaseSummary?.totals || {};
  const purchaseLast30Days = Number(purchaseTotals.last_30_days_ttc ?? 0);
  const purchaseTotal = Number(purchaseTotals.total_ttc ?? purchaseLast30Days ?? 0);
  const purchaseCount = Number(purchaseTotals.count ?? purchaseTotals.last_30_days_count ?? 0);
  const hasCollections = Boolean(collections);
  const purchasesToReview =
    Number(purchaseWorkflow?.states?.reviewing ?? 0) + Number(purchaseWorkflow?.states?.awaiting_supplier ?? 0);
  const readyToPayCount = Number(purchaseWorkflow?.states?.ready_to_pay ?? 0);
  const acceptedQuotesSource = dashboardAggregate?.accepted_quotes || acceptedQuotesSummary;
  const acceptedQuoteCount = Number(acceptedQuotesSource?.count ?? quotes.filter(isAcceptedQuoteReadyToInvoice).length);
  const rejectedQuoteCount = countByStatus(quotes, ["rejected"]);
  const expiredQuoteCount = countByStatus(quotes, ["expired"]);
  const acceptedQuotesAmount = safeNumber(
    acceptedQuotesSource?.amount ?? amountForAcceptedQuotesReadyToInvoice(quotes),
  );
  const vatNet = safeNumber(vatSummary?.net_vat);
  const vatAnomalyCount = countVatAnomalies(vatSummary);
  const vatAction = firstVatAction(vatSummary);
  const accountingMissing = safeNumber(accountingSummary?.missing_total);
  const invoiceNeedsAction = overdueCount > 0;
  const quoteNeedsAction = acceptedQuoteCount > 0;
  const controlNeedsAction = vatAnomalyCount + purchasesToReview + readyToPayCount + accountingMissing > 0;
  const urgentActionCount = [invoiceNeedsAction, quoteNeedsAction, controlNeedsAction].filter(Boolean).length;
  const refreshing = sessionLoading || summaryLoading || quotesLoading || invoicesLoading || supportLoading;
  const dashboardDataLoading = hydrated && refreshing;
  const firstDashboardLoad =
    dashboardDataLoading &&
    !metrics &&
    !collections &&
    !cash &&
    !dashboardAggregate &&
    quotes.length === 0 &&
    invoices.length === 0;
  const collectionsUnavailable = !dashboardDataLoading && !hasCollections;

  const refreshAll = async () => {
    await reloadSummary();
    setRefreshNonce((value) => value + 1);
  };
  const quoteCount = Number(summary?.quotes?.count || quotes.length || 0);
  const revenueThisMonth = Number(
    metrics?.invoiced_month ?? invoices.reduce((sum, invoice) => sum + Number(docTotal(invoice)), 0),
  );
  const dsoDays = Math.max(
    0,
    Math.round(
      safeNumber(dashboardAggregate?.dso_days ?? metrics?.dso_days) ||
        (revenueThisMonth > 0 ? (openBalance / Math.max(1, revenueThisMonth)) * 30 : overdueCount > 0 ? 30 : 0),
    ),
  );
  const periodLabels = useMemo(() => buildPeriodLabels(), []);
  const dashboardPeriodStart = dateParam(periodLabels.periodStart);
  const dashboardPeriodEnd = dateParam(periodLabels.periodEnd);
  const customerCount = Number(summary?.customers?.count || 0);
  const invoiceCount = Number(
    dashboardAggregate?.invoice_status?.total ?? summary?.invoices?.count ?? invoices.length ?? 0,
  );
  const setupStepsRaw = Array.isArray(summary?.setup?.steps) ? summary.setup.steps : [];
  const tokenFeatureEnabled = Boolean(
    capabilities?.einvoicing_operational || capabilities?.seqino_operational || capabilities?.chorus_operational,
  );
  const setupSteps = setupStepsRaw.filter((step: any) => tokenFeatureEnabled || step?.key !== "platforms");
  const setupTotal = setupSteps.length;
  const setupCompleted = setupSteps.filter((step: any) => Boolean(step?.done)).length;
  const setupPercent = setupTotal ? (setupCompleted / setupTotal) * 100 : 100;
  const primarySetupAction =
    setupSteps.find((step: any) => !step?.done) ||
    (Array.isArray(summary?.next_actions)
      ? summary.next_actions.find((action: any) => tokenFeatureEnabled || action?.key !== "platforms")
      : null) ||
    null;
  const hasOperationalHistory = customerCount > 0 || quoteCount > 0 || invoiceCount > 0;
  const showSetupGuide =
    !dashboardDataLoading &&
    setupTotal > 0 &&
    setupCompleted < setupTotal &&
    (!hasOperationalHistory || setupPercent < 60);
  const updatedLabel = dashboardDataLoading
    ? "Actualisation…"
    : error || summaryError
      ? "Données partielles"
      : summary?.generated_at
        ? `Mis à jour à ${shortTime(summary.generated_at)}`
        : "Données à jour";
  const invoicesHref = linkWithQuery("/app/invoices", {
    start_date: dashboardPeriodStart,
    end_date: dashboardPeriodEnd,
  });
  const purchasesHref = linkWithQuery("/app/purchases", {
    received_from: dashboardPeriodStart,
    received_to: dashboardPeriodEnd,
  });
  const cashIncomingHref = "/app/cash?view=incoming&period=30";
  const recentPayments = Array.isArray(cash?.recent_payments) ? cash.recent_payments : [];
  const supplierDocumentsRaw = cash?.supplier_documents;
  const supplierDocuments = useMemo(
    () => (Array.isArray(supplierDocumentsRaw) ? supplierDocumentsRaw : []),
    [supplierDocumentsRaw],
  );
  const pendingInvoicesHref = linkWithQuery("/app/invoices", {
    status: overdueCount > 0 ? "overdue" : "pending",
  });
  const readyPurchasesHref = linkWithQuery("/app/purchases", {
    filter: "ready_to_pay",
  });
  const vatCorrectionsHref =
    vatAction?.href ||
    linkWithQuery("/app/purchases", {
      filter: "vat_corrections",
    });
  const acceptedQuotesHref = linkWithQuery("/app/quotes", { status: "accepted" });
  const accountingExportHref = "/app/settings/export";
  const operationalCardsAll = [
    {
      label: "Factures à encaisser",
      value: dashboardDataLoading
        ? "Actualisation…"
        : overdueCount > 0
          ? `${pluralFr(overdueCount, "facture")} en retard`
          : openBalance > 0
            ? `${money(openBalance)} à encaisser`
            : "Tout est à jour",
      detail: dashboardDataLoading
        ? "Synchronisation des factures ouvertes."
        : collectionsUnavailable
          ? "Le détail des factures ouvertes n'a pas pu être chargé."
          : overdueCount > 0
            ? `${money(openBalance)} restent à suivre sur les factures ouvertes.`
            : openBalance > 0
              ? "Factures ouvertes suivies dans la liste des factures."
              : "Aucun encaissement client en attente.",
      accent: collectionsUnavailable || overdueCount > 0 ? "red" : openBalance > 0 ? "blue" : "green",
      href: pendingInvoicesHref,
      icon: FileText,
      badge: dashboardDataLoading
        ? "Chargement"
        : collectionsUnavailable
          ? "Non chargé"
          : overdueCount > 0
            ? `${overdueCount} en retard`
            : "OK",
      badgeColor: dashboardDataLoading || collectionsUnavailable ? "muted" : overdueCount > 0 ? "danger" : "ok",
      actionLabel: overdueCount > 0 ? "Vérifier" : "Voir",
    },
    {
      label: "Devis acceptés",
      value:
        acceptedQuoteCount > 0
          ? `${acceptedQuoteCount.toLocaleString("fr-FR")} devis accepté${acceptedQuoteCount > 1 ? "s" : ""}`
          : "Aucun devis accepté",
      detail:
        acceptedQuoteCount > 0
          ? `${acceptedQuotesSource?.truncated ? "Au moins " : ""}${money(acceptedQuotesAmount)} prêts à transformer en facture.`
          : rejectedQuoteCount + expiredQuoteCount > 0
            ? `${pluralFr(rejectedQuoteCount, "devis refusé")} · ${pluralFr(expiredQuoteCount, "devis expiré")} à archiver si besoin.`
            : "Aucun devis accepté en attente de facture.",
      accent: "green",
      href: acceptedQuoteCount > 0 ? acceptedQuotesHref : "/app/quotes",
      icon: FileText,
      badge: acceptedQuoteCount > 0 ? `${acceptedQuoteCount} à facturer` : "Suivi",
      badgeColor: acceptedQuoteCount > 0 ? "ok" : "muted",
      actionLabel: acceptedQuoteCount > 0 ? "Créer la facture" : "Voir",
    },
    {
      label: "Encaissements reçus",
      value: firstDashboardLoad ? "—" : money(paidLast30Days),
      detail: "Paiements rapprochés sur les 30 derniers jours.",
      accent: "green",
      href: cashIncomingHref,
      icon: Landmark,
      badge: "30 jours",
      badgeColor: "info",
      actionLabel: "Voir",
    },
    {
      label: "Contrôles",
      value:
        vatAnomalyCount + purchasesToReview + readyToPayCount + accountingMissing > 0
          ? `${pluralFr(vatAnomalyCount + purchasesToReview + readyToPayCount + accountingMissing, "point")} à vérifier`
          : "Dossier à jour",
      detail:
        vatAnomalyCount + purchasesToReview + readyToPayCount + accountingMissing > 0
          ? `TVA ${vatAnomalyCount} · achats ${purchasesToReview + readyToPayCount} · export ${accountingMissing}.`
          : `TVA nette ${money(vatNet)} · aucun blocage détecté.`,
      accent: "amber",
      href: vatAnomalyCount > 0 ? vatCorrectionsHref : readyToPayCount > 0 ? readyPurchasesHref : accountingExportHref,
      icon: Settings2,
      badge: vatAnomalyCount + purchasesToReview + readyToPayCount + accountingMissing > 0 ? "À vérifier" : "OK",
      badgeColor: vatAnomalyCount + purchasesToReview + readyToPayCount + accountingMissing > 0 ? "warn" : "ok",
      actionLabel: "Vérifier",
    },
  ] satisfies Array<{
    label: string;
    value: string;
    detail: string;
    accent: AccentKey;
    href: string;
    icon: ElementType;
    badge?: string;
    badgeColor?: "ok" | "warn" | "danger" | "muted" | "info" | "purple";
    actionLabel?: string;
  }>;
  const operationalCards = operationalCardsAll.filter(
    (card) =>
      (paymentsEnabled || !["Factures à encaisser", "Encaissements reçus"].includes(card.label)) &&
      (purchasesEnabled || card.label !== "Contrôles"),
  );
  const financeCellsAll = [
    {
      label: "À encaisser",
      value: firstDashboardLoad ? "—" : money(openBalance),
      detail: `${pluralFr(overdueCount, "facture")} en retard`,
      accent: overdueCount > 0 ? "amber" : "blue",
      href: invoicesHref,
    },
    {
      label: "Factures",
      value: firstDashboardLoad ? "—" : String(invoiceCount),
      detail: "Pièces suivies",
      accent: "blue",
      href: invoicesHref,
    },
    {
      label: "Devis",
      value: firstDashboardLoad ? "—" : String(quoteCount),
      detail: "Devis en cours",
      accent: "purple",
      href: "/app/quotes",
    },
    {
      label: "Achats",
      value: firstDashboardLoad ? "—" : String(purchaseCount),
      detail: `${purchasesToReview} à revoir · ${readyToPayCount} à payer`,
      accent: "coral",
      href: purchasesHref,
    },
    {
      label: "Encaissements",
      value: firstDashboardLoad ? "—" : money(paidLast30Days),
      detail: "30 derniers jours",
      accent: "green",
      href: cashIncomingHref,
    },
    {
      label: "DSO",
      value: firstDashboardLoad ? "—" : `${dsoDays} j`,
      detail: "Délai de paiement",
      accent: dsoDays > 45 ? "amber" : "cyan",
      href: "/app/customers",
    },
    {
      label: "Clients",
      value: firstDashboardLoad ? "—" : String(customerCount),
      detail: "Enregistrés",
      accent: "cyan",
      href: "/app/customers",
    },
  ] satisfies Array<{ label: string; value: string; detail: string; accent: AccentKey; href: string }>;
  const financeCells = financeCellsAll.filter(
    (cell) =>
      (purchasesEnabled || cell.label !== "Achats") &&
      (paymentsEnabled || !["À encaisser", "Encaissements", "DSO"].includes(cell.label)),
  );
  const analysisFlowData = useMemo(
    () =>
      aggregateFlowRows(dashboardAggregate, analysisPeriod) ||
      buildPeriodFlowData({ invoices, quotes, periodEnd: periodLabels.periodEnd, period: analysisPeriod }),
    [analysisPeriod, dashboardAggregate, invoices, periodLabels.periodEnd, quotes],
  );
  const analysisCollectedSeries = useMemo(
    () =>
      aggregateAmountRows(dashboardAggregate, analysisPeriod, "encaissements") ||
      buildPeriodAmountSeries({
        invoices,
        periodEnd: periodLabels.periodEnd,
        period: analysisPeriod,
        filter: (invoice) => ["paid", "partial"].includes(String(invoice?.status || "").toLowerCase()),
        value: (invoice) => Math.max(0, safeNumber(docTotal(invoice)) - safeNumber(invoice?.balance_due)),
      }),
    [analysisPeriod, dashboardAggregate, invoices, periodLabels.periodEnd],
  );
  const analysisPurchaseSeries = useMemo(
    () =>
      buildItemAmountSeries({
        items: supplierDocuments,
        periodEnd: periodLabels.periodEnd,
        period: analysisPeriod,
        date: (item) => item?.received_at || item?.date,
        value: (item) => Math.abs(safeNumber(item?.amount)),
      }),
    [analysisPeriod, periodLabels.periodEnd, supplierDocuments],
  );
  const analysisChartData = useMemo<DashboardChartBucket[]>(
    () =>
      analysisFlowData.map((item, index) => ({
        label: item.label,
        factures: safeNumber(item.factures),
        devis: safeNumber(item.devis),
        encaissements: safeNumber(analysisCollectedSeries[index]?.value),
        achats: safeNumber(analysisPurchaseSeries[index]?.value),
      })),
    [analysisCollectedSeries, analysisFlowData, analysisPurchaseSeries],
  );
  const activeAnalysisKeys = availableAnalysisSeries.filter((key) => activeAnalysisSeries[key]);
  const analysisVisibleTotal = analysisChartData.reduce(
    (sum, item) => sum + activeAnalysisKeys.reduce((seriesSum, key) => seriesSum + safeNumber(item[key]), 0),
    0,
  );
  return (
    <div>
      <AppPageHeader
        breadcrumb="Pilotage"
        title="Tableau de bord"
        actions={
          <>
            <button
              type="button"
              onClick={refreshAll}
              disabled={refreshing}
              className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-[#dbe4f0] bg-white px-3 text-[var(--pf-app-text-body)] font-semibold text-[#475569] shadow-sm transition-colors hover:bg-[#f8fafc] disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              Actualiser
            </button>
            <Link
              to="/app/new"
              className="inline-flex min-h-9 items-center gap-2 rounded-xl bg-[#2563eb] px-3.5 text-[var(--pf-app-text-body)] font-semibold text-white shadow-[0_10px_22px_-15px_rgba(37,99,235,0.9)] transition hover:bg-[#1d4ed8]"
            >
              <Plus className="h-3.5 w-3.5" />
              Nouveau document
            </Link>
          </>
        }
      />

      <WorkbenchPage maxWidth="none">
        {(error || summaryError) && (
          <NoticeBanner variant="danger" title="Données partielles">
            {error || summaryError}
          </NoticeBanner>
        )}

        <div className="space-y-6 pb-24 md:pb-8">
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="space-y-4"
          >
            <SectionHeader
              title="À suivre maintenant"
              right={
                <span className="inline-flex items-center gap-1 text-[var(--pf-app-text-caption)] font-medium text-[#64748b]">
                  <Zap className="h-3.5 w-3.5 text-[#d97706]" />
                  {urgentActionCount > 0
                    ? `${urgentActionCount} action${urgentActionCount > 1 ? "s" : ""} urgente${urgentActionCount > 1 ? "s" : ""}`
                    : "Aucune action urgente"}
                </span>
              }
            />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              {operationalCards.map((card) => (
                <OperationalActionCard key={card.label} {...card} />
              ))}
            </div>
          </motion.section>

          {showSetupGuide ? (
            <motion.section
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: 0.03 }}
            >
              <SetupGuide steps={setupSteps} percent={setupPercent} primaryAction={primarySetupAction} />
            </motion.section>
          ) : null}

          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.04 }}
            className="space-y-4"
          >
            <SectionHeader title="Chiffres clés" />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
              {financeCells.map((cell) => (
                <FinanceCell key={cell.label} {...cell} />
              ))}
            </div>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.16 }}
            className="space-y-4"
          >
            <SectionHeader
              title="Tendances"
              right={
                <span className="text-[var(--pf-app-text-caption)] font-semibold text-[#64748b]">{updatedLabel}</span>
              }
            />
            <div className="grid grid-cols-1 gap-5">
              <ChartCard
                title="Évolution de l'activité"
                value={firstDashboardLoad ? "—" : money(analysisVisibleTotal)}
                right={<AnalysisPeriodControl value={analysisPeriod} onChange={setAnalysisPeriod} />}
                valueLayout="hero"
              >
                <MonthlyFlowChart
                  data={analysisChartData}
                  activeSeries={activeAnalysisSeries}
                  availableSeries={availableAnalysisSeries}
                  onToggleSeries={toggleAnalysisSeries}
                />
              </ChartCard>
            </div>
          </motion.section>

          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.2 }}
            className="space-y-4"
          >
            <SectionHeader title="Activité récente" />
            <div className="grid grid-cols-1 items-start gap-5 2xl:grid-cols-2">
              <RecentDocumentsPanel
                title="Dernières factures"
                href="/app/invoices"
                rows={invoices}
                loading={hydrated && (sessionLoading || invoicesLoading)}
                emptyLabel="Chargement des factures…"
                createHref="/app/invoices/new"
                createLabel="Créer une facture"
                accent="blue"
                type="invoice"
              />
              <RecentDocumentsPanel
                title="Derniers devis"
                href="/app/quotes"
                rows={quotes}
                loading={hydrated && (sessionLoading || quotesLoading)}
                emptyLabel="Chargement des devis…"
                createHref="/app/quotes/new"
                createLabel="Créer un devis"
                accent="purple"
                type="quote"
              />
              {paymentsEnabled ? (
                <RecentPaymentsPanel
                  rows={recentPayments}
                  loading={hydrated && (sessionLoading || supportLoading)}
                  className="xl:col-span-2"
                />
              ) : null}
            </div>
          </motion.section>
        </div>
      </WorkbenchPage>
    </div>
  );
}
