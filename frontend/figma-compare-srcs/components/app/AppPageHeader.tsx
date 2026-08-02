import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  ArrowUpDown,
  Info,
  CheckCircle2,
  XCircle,
  X,
  MoreHorizontal,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Link } from "react-router";
import { Children, isValidElement, useMemo, useState, useRef, useEffect } from "react";

/* ══════════════════════════════════════════════════════════
   AppPageHeader
══════════════════════════════════════════════════════════ */
interface AppPageHeaderProps {
  title: string;
  breadcrumb?: string;
  description?: string;
  backHref?: string;
  actions?: React.ReactNode;
  badge?: React.ReactNode;
}

export function AppPageHeader({ title, breadcrumb, backHref, actions, badge }: AppPageHeaderProps) {
  const breadcrumbParts = String(breadcrumb || "")
    .split(/[·›>]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const rawSectionLabel = breadcrumbParts[0] || null;
  const normalizedSectionLabel = rawSectionLabel
    ?.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const sectionLabel = normalizedSectionLabel === "parametres" ? "Paramètres" : null;
  const currentLabel = sectionLabel ? breadcrumbParts[breadcrumbParts.length - 1] || title : title;

  return (
    <div className="pf-app-page-header sticky top-0 z-40 border-b border-[#e2e8f0] bg-white py-3 pl-14 pr-4 sm:px-4 lg:px-6">
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 sm:w-auto">
          <div className="flex min-w-0 items-center gap-2">
            {backHref ? (
              <Link
                to={backHref}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#94a3b8] transition hover:bg-[#f8fafc] hover:text-[#0f172a]"
                aria-label="Retour"
              >
                <ArrowLeft className="w-4 h-4" />
              </Link>
            ) : null}
            {sectionLabel ? (
              backHref ? (
                <Link
                  to={backHref}
                  className="hidden shrink-0 text-[#64748b] transition hover:text-[#1d4ed8] sm:inline"
                  style={{ fontSize: "0.8125rem", fontWeight: 560 }}
                >
                  {sectionLabel}
                </Link>
              ) : (
                <span
                  className="hidden shrink-0 text-[#64748b] sm:inline"
                  style={{ fontSize: "0.8125rem", fontWeight: 560 }}
                >
                  {sectionLabel}
                </span>
              )
            ) : null}
            {sectionLabel ? (
              <ChevronRight className="hidden w-3.5 h-3.5 shrink-0 text-[#cbd5e1] sm:block" aria-hidden="true" />
            ) : null}
            <h1
              className="truncate text-[#0f172a]"
              style={{ fontSize: "0.875rem", fontWeight: 740, letterSpacing: 0, lineHeight: 1.2 }}
            >
              {currentLabel || title}
            </h1>
            {badge ? <div className="shrink-0">{badge}</div> : null}
          </div>
        </div>
        {actions ? (
          <div className="flex w-full max-w-full flex-wrap items-center justify-start gap-2 sm:w-auto sm:flex-shrink-0 sm:justify-end">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   StatusPill
══════════════════════════════════════════════════════════ */
type PillStatus = "ok" | "warn" | "danger" | "muted" | "info" | "purple";

export function StatusPill({ status, label, color }: { status?: PillStatus; label: string; color?: PillStatus }) {
  const s = status || color || "muted";
  const cfg: Record<PillStatus, { bg: string; text: string; dot: string; border: string }> = {
    ok: { bg: "#f0fdf4", text: "#166534", dot: "#22c55e", border: "#bbf7d0" },
    warn: { bg: "#fffbeb", text: "#92400e", dot: "#fbbf24", border: "#fde68a" },
    danger: { bg: "#fef2f2", text: "#b91c1c", dot: "#f87171", border: "#fecaca" },
    muted: { bg: "#f8fafc", text: "#475569", dot: "#cbd5e1", border: "#e2e8f0" },
    info: { bg: "#eff6ff", text: "#1d4ed8", dot: "#60a5fa", border: "#bfdbfe" },
    purple: { bg: "#f5f3ff", text: "#6d28d9", dot: "#a78bfa", border: "#ddd6fe" },
  };
  const c = cfg[s];
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full"
      style={{
        fontSize: "var(--pf-app-text-body)",
        fontWeight: 600,
        background: c.bg,
        color: c.text,
        border: `1px solid ${c.border}`,
      }}
    >
      <span className="w-[5px] h-[5px] rounded-full flex-shrink-0" style={{ background: c.dot }} />
      {label}
    </span>
  );
}

/* ══════════════════════════════════════════════════════════
   StatCard — redesigned: big number, no border, shadow only
══════════════════════════════════════════════════════════ */
type AccentColor = "blue" | "green" | "amber" | "red" | "purple" | "cyan";

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  accent?: AccentColor;
  trend?: "up" | "down" | "flat";
  trendValue?: string;
  icon?: React.ReactNode;
}

export function StatCard({ label, value, sub, accent, trend, trendValue, icon }: StatCardProps) {
  const palette: Record<AccentColor, { iconBg: string; iconColor: string; valueColor: string; topBar: string }> = {
    blue: { iconBg: "#dbeafe", iconColor: "#1d4ed8", valueColor: "#0f172a", topBar: "#1d4ed8" },
    green: { iconBg: "#dcfce7", iconColor: "#16a34a", valueColor: "#0f172a", topBar: "#16a34a" },
    amber: { iconBg: "#fef3c7", iconColor: "#d97706", valueColor: "#0f172a", topBar: "#d97706" },
    red: { iconBg: "#fee2e2", iconColor: "#dc2626", valueColor: "#0f172a", topBar: "#dc2626" },
    purple: { iconBg: "#ede9fe", iconColor: "#7c3aed", valueColor: "#0f172a", topBar: "#7c3aed" },
    cyan: { iconBg: "#cffafe", iconColor: "#0891b2", valueColor: "#0f172a", topBar: "#0891b2" },
  };
  const c = accent ? palette[accent] : null;

  return (
    <div
      className="relative bg-white rounded-xl p-4 overflow-hidden transition-all duration-200 hover:-translate-y-0.5"
      style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)" }}
    >
      {/* Colored top accent bar */}
      {c && <div className="absolute top-0 left-0 right-0 h-[3px] rounded-t-2xl" style={{ background: c.topBar }} />}

      <div className="flex items-start justify-between mb-3 mt-0.5">
        <span
          className="block"
          style={{
            fontSize: "var(--pf-app-text-overline)",
            fontWeight: 600,
            color: "#94a3b8",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {label}
        </span>
        {icon && c && (
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: c.iconBg, color: c.iconColor }}
          >
            {icon}
          </div>
        )}
        {icon && !c && (
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-[#f4f6fa] text-[#94a3b8]">
            {icon}
          </div>
        )}
      </div>

      <div
        style={{
          fontSize: "var(--pf-app-text-value)",
          fontWeight: 800,
          letterSpacing: 0,
          lineHeight: 1,
          color: c ? c.valueColor : "#0f172a",
        }}
      >
        {value}
      </div>

      {(sub || (trend && trendValue)) && (
        <div className="flex items-center justify-between mt-2">
          {sub && <span style={{ fontSize: "var(--pf-app-text-caption)", color: "#94a3b8" }}>{sub}</span>}
          {trend && trendValue && (
            <div
              className="flex items-center gap-1 ml-auto"
              style={{
                fontSize: "var(--pf-app-text-overline)",
                fontWeight: 600,
                color: trend === "up" ? "#16a34a" : trend === "down" ? "#dc2626" : "#94a3b8",
              }}
            >
              {trend === "up" ? (
                <TrendingUp className="w-3 h-3" />
              ) : trend === "down" ? (
                <TrendingDown className="w-3 h-3" />
              ) : (
                <Minus className="w-3 h-3" />
              )}
              {trendValue}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   PrimaryButton
══════════════════════════════════════════════════════════ */
export function PrimaryButton({
  children,
  className = "",
  style: extStyle,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { style?: React.CSSProperties }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-white transition-all active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      style={{
        fontSize: "var(--pf-app-text-body)",
        fontWeight: 600,
        background: "linear-gradient(135deg, #1d4ed8 0%, #4f46e5 100%)",
        color: "#ffffff",
        boxShadow: "0 1px 3px rgba(29,78,216,0.4), inset 0 1px 0 rgba(255,255,255,0.15)",
        ...extStyle,
      }}
      {...props}
    >
      {children}
    </button>
  );
}

/* ══════════════════════════════════════════════════════════
   SecondaryButton
══════════════════════════════════════════════════════════ */
export function SecondaryButton({ children, className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[#374151] bg-white transition-all active:scale-[0.97] hover:bg-[#f8fafc] disabled:opacity-50 ${className}`}
      style={{
        fontSize: "var(--pf-app-text-body)",
        fontWeight: 500,
        border: "1px solid rgba(0,0,0,0.08)",
        boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
      }}
      {...props}
    >
      {children}
    </button>
  );
}

/* ══════════════════════════════════════════════════════════
   DangerButton
══════════════════════════════════════════════════════════ */
export function DangerButton({ children, className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-white transition-all active:scale-[0.97] disabled:opacity-50 ${className}`}
      style={{
        fontSize: "var(--pf-app-text-body)",
        fontWeight: 600,
        background: "linear-gradient(135deg,#dc2626,#ef4444)",
        boxShadow: "0 1px 3px rgba(220,38,38,0.35), inset 0 1px 0 rgba(255,255,255,0.12)",
      }}
      {...props}
    >
      {children}
    </button>
  );
}

/* ══════════════════════════════════════════════════════════
   InputField
══════════════════════════════════════════════════════════ */
export function InputField({
  label,
  required,
  hint,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <div>
      <label
        className="block mb-1.5"
        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 500, color: "#374151" }}
      >
        {label}
        {required && (
          <span style={{ color: "#ef4444" }} className="ml-0.5">
            *
          </span>
        )}
      </label>
      <input
        className="w-full px-3 py-2 rounded-lg bg-white text-[#0f172a] placeholder:text-[#94a3b8] transition-all focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/25"
        style={{
          fontSize: "var(--pf-app-text-body)",
          border: "1px solid rgba(0,0,0,0.08)",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        }}
        {...props}
      />
      {hint && (
        <p className="mt-1.5 text-[#94a3b8]" style={{ fontSize: "var(--pf-app-text-caption)" }}>
          {hint}
        </p>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   SelectField
══════════════════════════════════════════════════════════ */
export function SelectField({
  label,
  required,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return (
    <div>
      <label
        className="block mb-1.5"
        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 500, color: "#374151" }}
      >
        {label}
        {required && (
          <span style={{ color: "#ef4444" }} className="ml-0.5">
            *
          </span>
        )}
      </label>
      <select
        className="w-full px-3 py-2 rounded-lg bg-white text-[#0f172a] transition-all focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/25 appearance-none cursor-pointer"
        style={{
          fontSize: "var(--pf-app-text-body)",
          border: "1px solid rgba(0,0,0,0.08)",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        }}
        {...props}
      >
        {children}
      </select>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   DataTable — redesigned: no outer border, row dividers only
══════════════════════════════════════════════════════════ */
type DataTableSortDirection = "asc" | "desc";

function dataTableTextValue(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(dataTableTextValue).join(" ");
  if (isValidElement(node)) return dataTableTextValue((node.props as { children?: React.ReactNode }).children);
  return "";
}

function dataTableComparableValue(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  const dateMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dateMatch) {
    const [, day, month, year] = dateMatch;
    return Number(`${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`);
  }
  const numeric = Number(normalized.replace(/\s/g, "").replace("€", "").replace(",", "."));
  if (Number.isFinite(numeric) && /[\d]/.test(normalized)) return numeric;
  return normalized
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function dataTableCellValue(row: React.ReactNode, columnIndex: number) {
  if (!isValidElement(row)) return "";
  const cells = Children.toArray((row.props as { children?: React.ReactNode }).children);
  return dataTableComparableValue(dataTableTextValue(cells[columnIndex]));
}

export function DataTable({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  const [sortState, setSortState] = useState<{ index: number; direction: DataTableSortDirection } | null>(null);
  const sortedChildren = useMemo(() => {
    const rows = Children.toArray(children);
    if (!sortState) return rows;
    return rows
      .map((row, originalIndex) => ({ row, originalIndex, value: dataTableCellValue(row, sortState.index) }))
      .sort((a, b) => {
        const multiplier = sortState.direction === "asc" ? 1 : -1;
        let result = 0;
        if (typeof a.value === "number" || typeof b.value === "number") {
          result = (Number(a.value) || 0) - (Number(b.value) || 0);
        } else {
          result = String(a.value || "").localeCompare(String(b.value || ""), "fr", {
            numeric: true,
            sensitivity: "base",
          });
        }
        return result === 0 ? a.originalIndex - b.originalIndex : result * multiplier;
      })
      .map((item) => item.row);
  }, [children, sortState]);
  const toggleSort = (index: number) => {
    setSortState((current) =>
      current?.index === index
        ? { index, direction: current.direction === "asc" ? "desc" : "asc" }
        : { index, direction: "asc" },
    );
  };
  return (
    <div
      className="bg-white rounded-2xl overflow-hidden"
      style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)" }}
    >
      <div className="overflow-x-auto">
        <table className="pf-data-table w-full">
          <thead>
            <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
              {headers.map((h, i) => {
                const isTrailingAction = i === headers.length - 1 && /^actions?$/i.test(h.trim());
                return (
                  <th
                    key={`${h}-${i}`}
                    className="px-4 py-2.5 text-left"
                    style={{
                      fontSize: "var(--pf-app-text-overline)",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: "#94a3b8",
                      background: "#fafbfd",
                    }}
                  >
                    {isTrailingAction ? null : (
                      <DataTableHeaderLabel
                        active={sortState?.index === i}
                        direction={sortState?.index === i ? sortState.direction : undefined}
                        onClick={() => toggleSort(i)}
                      >
                        {h}
                      </DataTableHeaderLabel>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>{sortedChildren}</tbody>
        </table>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   Card — borderless, shadow only
══════════════════════════════════════════════════════════ */
export function Card({
  children,
  className = "",
  padding = true,
}: {
  children: React.ReactNode;
  className?: string;
  padding?: boolean;
}) {
  return (
    <div
      className={`bg-white rounded-2xl ${padding ? "px-4 py-3.5" : ""} ${className}`}
      style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)" }}
    >
      {children}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   SectionTitle
══════════════════════════════════════════════════════════ */
export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h3 style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650, color: "#0d1117" }}>{children}</h3>
      {action}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   NoticeBanner — alerte inline contextuelle
══════════════════════════════════════════════════════════ */
type BannerVariant = "info" | "warn" | "danger" | "success";

export function NoticeBanner({
  variant = "info",
  title,
  children,
  action,
  onDismiss,
  autoDismissMs,
}: {
  variant?: BannerVariant;
  title?: string;
  children: React.ReactNode;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  autoDismissMs?: number;
}) {
  const cfg: Record<
    BannerVariant,
    { bg: string; border: string; icon: React.ElementType; iconColor: string; textColor: string }
  > = {
    info: { bg: "#eff6ff", border: "#bfdbfe", icon: Info, iconColor: "#1d4ed8", textColor: "#1e40af" },
    warn: { bg: "#fffbeb", border: "#fde68a", icon: AlertTriangle, iconColor: "#d97706", textColor: "#92400e" },
    danger: { bg: "#fef2f2", border: "#fecaca", icon: XCircle, iconColor: "#dc2626", textColor: "#991b1b" },
    success: { bg: "#f0fdf4", border: "#bbf7d0", icon: CheckCircle2, iconColor: "#16a34a", textColor: "#14532d" },
  };
  const c = cfg[variant];
  useEffect(() => {
    if (!onDismiss || !autoDismissMs || autoDismissMs <= 0) return;
    const timer = window.setTimeout(onDismiss, autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [autoDismissMs, onDismiss]);
  return (
    <div
      className="flex items-start gap-3 rounded-2xl p-4"
      style={{ background: c.bg, border: `1px solid ${c.border}` }}
    >
      <c.icon className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: c.iconColor }} />
      <div className="flex-1 min-w-0">
        {title && (
          <p className="mb-0.5" style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 600, color: c.textColor }}>
            {title}
          </p>
        )}
        <div style={{ fontSize: "var(--pf-app-text-body)", color: c.textColor, lineHeight: 1.5 }}>{children}</div>
      </div>
      {action && (
        <button
          onClick={action.onClick}
          className="flex-shrink-0 transition-opacity hover:opacity-75"
          style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 600, color: c.iconColor }}
        >
          {action.label}
        </button>
      )}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-white/60"
          style={{ color: c.iconColor }}
          aria-label="Fermer le message"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   EmptyCard — état vide standardisé
══════════════════════════════════════════════════════════ */
export function EmptyCard({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: React.ElementType;
  title: string;
  description?: string;
  action?: { label: string; href?: string; onClick?: () => void };
}) {
  return (
    <div
      className="bg-white rounded-2xl flex flex-col items-center justify-center text-center py-16 px-8"
      style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)" }}
    >
      {Icon && (
        <div className="w-12 h-12 rounded-2xl bg-[#f4f6fa] flex items-center justify-center mb-4">
          <Icon className="w-6 h-6 text-[#94a3b8]" style={{ strokeWidth: 1.5 }} />
        </div>
      )}
      <h3 className="text-[#374151] mb-1" style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 600 }}>
        {title}
      </h3>
      {description && (
        <p className="text-[#94a3b8] mb-5 max-w-xs" style={{ fontSize: "var(--pf-app-text-body)", lineHeight: 1.55 }}>
          {description}
        </p>
      )}
      {action &&
        (action.href ? (
          <Link
            to={action.href}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-white transition-all"
            style={{
              fontSize: "var(--pf-app-text-body)",
              fontWeight: 600,
              background: "linear-gradient(135deg,#1d4ed8,#4f46e5)",
              boxShadow: "0 2px 8px rgba(29,78,216,0.3)",
            }}
          >
            {action.label}
          </Link>
        ) : (
          <button
            onClick={action.onClick}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-white transition-all"
            style={{
              fontSize: "var(--pf-app-text-body)",
              fontWeight: 600,
              background: "linear-gradient(135deg,#1d4ed8,#4f46e5)",
              boxShadow: "0 2px 8px rgba(29,78,216,0.3)",
            }}
          >
            {action.label}
          </button>
        ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   ActionMenu — bouton "Plus" avec dropdown
══════════════════════════════════════════════════════════ */
type ActionMenuItem = {
  label: string;
  icon?: React.ElementType;
  onClick?: () => void;
  href?: string;
  danger?: boolean;
  divider?: boolean;
};

export function ActionMenu({
  items,
  label: triggerLabel = "Plus",
  badge,
  triggerVariant = "default",
  triggerIcon: TriggerIcon,
  iconOnly = false,
  className = "",
}: {
  items: ActionMenuItem[];
  label?: string;
  badge?: React.ReactNode;
  triggerVariant?: "default" | "orange" | "primary" | "purple" | "success";
  triggerIcon?: React.ElementType;
  iconOnly?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerStyles: Record<"default" | "orange" | "primary" | "purple" | "success", React.CSSProperties> = {
    default: {
      color: "#374151",
      background: "#ffffff",
      border: "1px solid rgba(0,0,0,0.08)",
      boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
    },
    orange: {
      color: "#ffffff",
      background: "#f97316",
      border: "1px solid #ea580c",
      boxShadow: "0 10px 22px -16px rgba(234,88,12,0.95)",
    },
    primary: {
      color: "#ffffff",
      background: "#2563eb",
      border: "1px solid #1d4ed8",
      boxShadow: "0 10px 22px -16px rgba(29,78,216,0.85)",
    },
    purple: {
      color: "#ffffff",
      background: "#7c3aed",
      border: "1px solid #6d28d9",
      boxShadow: "0 10px 22px -16px rgba(109,40,217,0.85)",
    },
    success: {
      color: "#ffffff",
      background: "#15803d",
      border: "1px solid #15803d",
      boxShadow: "0 10px 22px -16px rgba(21,128,61,0.85)",
    },
  };
  const coloredTrigger = triggerVariant !== "default";

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={iconOnly ? triggerLabel : undefined}
        title={iconOnly ? triggerLabel : undefined}
        className={`inline-flex items-center justify-center gap-1.5 rounded-lg transition-all ${
          iconOnly ? "h-9 w-9 px-0 py-0" : "px-3 py-1.5"
        } ${coloredTrigger ? "hover:brightness-95" : "hover:bg-[#f8fafc]"}`}
        style={{
          fontSize: "var(--pf-app-text-body)",
          fontWeight: coloredTrigger ? 760 : 500,
          ...triggerStyles[triggerVariant],
        }}
      >
        {iconOnly && TriggerIcon ? (
          <TriggerIcon className="h-4 w-4" />
        ) : (
          <>
            {TriggerIcon ? <TriggerIcon className="h-3.5 w-3.5" /> : null}
            {triggerLabel}
            {badge != null ? (
              <span
                className="inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-center"
                style={{
                  fontSize: "0.6875rem",
                  fontWeight: 900,
                  lineHeight: 1.2,
                  color: coloredTrigger ? "#fff" : "#475569",
                  background: coloredTrigger ? "rgba(255,255,255,0.18)" : "#f1f5f9",
                }}
              >
                {badge}
              </span>
            ) : null}
            <ChevronDown
              className={`h-3.5 w-3.5 ${coloredTrigger ? "text-white/85" : "text-[#94a3b8]"}`}
              style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform 150ms" }}
            />
          </>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 w-52 rounded-xl overflow-hidden z-50 py-1"
          style={{ background: "white", boxShadow: "0 4px 24px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.06)" }}
        >
          {items.map((item, i) => {
            if (item.divider) return <div key={`div-${i}`} className="my-1 border-t border-[#f1f5f9]" />;
            const inner = (
              <span className="flex items-center gap-2 px-3 py-1.5">
                {item.icon && (
                  <item.icon
                    className="w-4 h-4 flex-shrink-0"
                    style={{ color: item.danger ? "#dc2626" : "#64748b", strokeWidth: 1.8 }}
                  />
                )}
                <span style={{ fontSize: "var(--pf-app-text-body)", color: item.danger ? "#dc2626" : "#374151" }}>
                  {item.label}
                </span>
              </span>
            );
            return item.href ? (
              <Link
                key={item.label}
                to={item.href}
                className="block hover:bg-[#f8fafc] transition-colors"
                onClick={() => setOpen(false)}
              >
                {inner}
              </Link>
            ) : (
              <button
                key={item.label}
                className="w-full text-left hover:bg-[#f8fafc] transition-colors"
                onClick={() => {
                  item.onClick?.();
                  setOpen(false);
                }}
              >
                {inner}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function DataTableHeaderLabel({
  children,
  active = false,
  direction,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  direction?: DataTableSortDirection;
  onClick?: () => void;
}) {
  if (!children) return null;
  const SortIcon = active ? (direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  const content = (
    <>
      <span>{children}</span>
      <SortIcon
        className={`h-3 w-3 ${active ? "text-[#f97316]" : "text-[#cbd5e1] group-hover:text-[#f97316]"}`}
        aria-hidden="true"
      />
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={`Trier par ${children}`}
        aria-pressed={active}
        className={`group inline-flex items-center gap-1.5 transition-colors hover:text-[#ea580c] ${
          active ? "pf-sort-header-active text-[#ea580c]" : ""
        }`}
      >
        {content}
      </button>
    );
  }
  return <span className="inline-flex items-center gap-1.5">{content}</span>;
}
