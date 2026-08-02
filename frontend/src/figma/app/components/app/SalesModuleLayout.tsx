"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";

type SalesModuleTone = "clients" | "quotes" | "invoices" | "payments";
export type ModuleThemeTone =
  | SalesModuleTone
  | "essential"
  | "action_center"
  | "purchases"
  | "receivables"
  | "transmissions"
  | "cash"
  | "catalog"
  | "portfolio"
  | "tasks"
  | "notifications"
  | "scheduler"
  | "automations";
export type ModuleAccentTone = "module" | "success" | "warning" | "danger" | "info" | "muted" | "purple";
type SalesDensity = "default" | "client";

export type ModuleTheme = {
  accent: string;
  soft: string;
  strong: string;
  border: string;
  gradient: string;
};

const MODULE_THEMES: Record<ModuleThemeTone, ModuleTheme> = {
  essential: {
    accent: "#2563eb",
    soft: "#eff6ff",
    strong: "#1d4ed8",
    border: "#93c5fd",
    gradient: "#2563eb",
  },
  clients: {
    accent: "#f97316",
    soft: "#fff7ed",
    strong: "#ea580c",
    border: "#fdba74",
    gradient: "#f97316",
  },
  quotes: {
    accent: "#7c3aed",
    soft: "#f5f3ff",
    strong: "#6d28d9",
    border: "#d8b4fe",
    gradient: "#7c3aed",
  },
  invoices: {
    accent: "#5B5EF4",
    soft: "#EFF0FE",
    strong: "#4A4CE0",
    border: "#C7D2FE",
    gradient: "#5B5EF4",
  },
  payments: {
    accent: "#f97316",
    soft: "#fff7ed",
    strong: "#ea580c",
    border: "#fdba74",
    gradient: "#f97316",
  },
  action_center: {
    accent: "#0f766e",
    soft: "#ecfdf5",
    strong: "#0f766e",
    border: "#99f6e4",
    gradient: "#0f766e",
  },
  purchases: {
    accent: "#16a34a",
    soft: "#f0fdf4",
    strong: "#15803d",
    border: "#86efac",
    gradient: "#16a34a",
  },
  receivables: {
    accent: "#2563eb",
    soft: "#eff6ff",
    strong: "#1d4ed8",
    border: "#93c5fd",
    gradient: "#2563eb",
  },
  transmissions: {
    accent: "#4f46e5",
    soft: "#eef2ff",
    strong: "#4338ca",
    border: "#a5b4fc",
    gradient: "#4f46e5",
  },
  cash: {
    accent: "#16a34a",
    soft: "#f0fdf4",
    strong: "#15803d",
    border: "#86efac",
    gradient: "#16a34a",
  },
  catalog: {
    accent: "#0f766e",
    soft: "#f0fdfa",
    strong: "#0f766e",
    border: "#99f6e4",
    gradient: "#0f766e",
  },
  portfolio: {
    accent: "#0f766e",
    soft: "#f0fdfa",
    strong: "#0f766e",
    border: "#99f6e4",
    gradient: "#0f766e",
  },
  tasks: {
    accent: "#475569",
    soft: "#f8fafc",
    strong: "#334155",
    border: "#cbd5e1",
    gradient: "#475569",
  },
  notifications: {
    accent: "#7c3aed",
    soft: "#f5f3ff",
    strong: "#6d28d9",
    border: "#d8b4fe",
    gradient: "#7c3aed",
  },
  scheduler: {
    accent: "#2563eb",
    soft: "#eff6ff",
    strong: "#1d4ed8",
    border: "#93c5fd",
    gradient: "#2563eb",
  },
  automations: {
    accent: "#7c3aed",
    soft: "#f5f3ff",
    strong: "#6d28d9",
    border: "#d8b4fe",
    gradient: "#7c3aed",
  },
};

const MODULE_ACCENTS: Record<Exclude<ModuleAccentTone, "module">, ModuleTheme> = {
  success: {
    accent: "#16a34a",
    soft: "#f0fdf4",
    strong: "#15803d",
    border: "#86efac",
    gradient: "#16a34a",
  },
  warning: {
    accent: "#f59e0b",
    soft: "#fffbeb",
    strong: "#d97706",
    border: "#fcd34d",
    gradient: "#f59e0b",
  },
  danger: {
    accent: "#ef4444",
    soft: "#fef2f2",
    strong: "#dc2626",
    border: "#fca5a5",
    gradient: "#ef4444",
  },
  info: {
    accent: "#2563eb",
    soft: "#eff6ff",
    strong: "#1d4ed8",
    border: "#93c5fd",
    gradient: "#2563eb",
  },
  muted: {
    accent: "#94a3b8",
    soft: "#f8fafc",
    strong: "#64748b",
    border: "#cbd5e1",
    gradient: "#94a3b8",
  },
  purple: {
    accent: "#7c3aed",
    soft: "#f5f3ff",
    strong: "#6d28d9",
    border: "#d8b4fe",
    gradient: "#7c3aed",
  },
};

export function getModuleTheme(tone: ModuleThemeTone) {
  return MODULE_THEMES[tone];
}

export function getSalesTheme(tone: SalesModuleTone) {
  return MODULE_THEMES[tone];
}

function resolveModuleTheme(tone: ModuleThemeTone, accent: ModuleAccentTone = "module") {
  return accent === "module" ? MODULE_THEMES[tone] : MODULE_ACCENTS[accent];
}

export function SalesMetricsGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 lg:gap-4 md:grid-cols-2 xl:grid-cols-4">{children}</div>;
}

export function SalesMetricCard({
  tone,
  label,
  value,
  detail,
  icon,
  accent = "module",
  density = "default",
  onClick,
  active = false,
  ariaLabel,
  disabled = false,
}: {
  tone: ModuleThemeTone;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  accent?: ModuleAccentTone;
  density?: SalesDensity;
  onClick?: () => void;
  active?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const theme = resolveModuleTheme(tone, accent);
  const isClientDensity = density === "client";
  const isInteractive = typeof onClick === "function";
  const rootClassName = `overflow-hidden bg-white text-left transition-all ${
    !disabled ? "hover:-translate-y-[1px]" : ""
  } ${isClientDensity ? "rounded-2xl" : "rounded-[24px]"} ${
    isInteractive ? "w-full focus:outline-none focus:ring-2 focus:ring-offset-2" : ""
  } ${disabled ? "cursor-not-allowed opacity-60" : ""}`;
  const rootStyle: CSSProperties = {
    border: `1px solid ${active ? theme.border : `${theme.border}55`}`,
    boxShadow: active
      ? `0 0 0 3px ${theme.soft}, 0 10px 28px rgba(15,23,42,0.08)`
      : isClientDensity
        ? "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)"
        : "0 1px 3px rgba(15,23,42,0.04), 0 16px 40px rgba(15,23,42,0.06)",
  };
  const content = (
    <>
      <div className={isClientDensity ? "h-[3px] w-full" : "h-1.5 w-full"} style={{ background: theme.gradient }} />
      <div
        className={`flex items-start justify-between gap-3 ${isClientDensity ? "px-4 py-4" : "min-h-[124px] px-4 py-4"}`}
      >
        <div className="min-w-0 flex-1">
          <div
            className="uppercase tracking-[0.08em] text-[#64748b]"
            style={{
              fontSize: "var(--pf-app-text-overline)",
              fontWeight: isClientDensity ? 650 : 800,
              letterSpacing: "0.04em",
            }}
          >
            {label}
          </div>
          <div
            className={isClientDensity ? "mt-3 text-[#0f172a]" : "mt-4 text-[#0f172a]"}
            style={{
              fontSize: "var(--pf-app-text-value)",
              lineHeight: isClientDensity ? 1 : 1.05,
              fontWeight: 800,
              letterSpacing: 0,
            }}
          >
            {value}
          </div>
          {detail ? (
            <div
              className={isClientDensity ? "mt-1.5 text-[#64748b]" : "mt-2.5 text-[#64748b]"}
              style={{
                fontSize: isClientDensity ? "var(--pf-app-text-caption)" : "var(--pf-app-text-body)",
                lineHeight: "var(--pf-app-line-normal)",
              }}
            >
              {detail}
            </div>
          ) : null}
        </div>
        {icon ? (
          <div
            className={`flex flex-shrink-0 items-center justify-center ${isClientDensity ? "h-8 w-8 rounded-lg" : "h-10 w-10 rounded-xl"}`}
            style={{ background: theme.soft, color: theme.strong }}
          >
            {icon}
          </div>
        ) : null}
      </div>
    </>
  );

  if (isInteractive) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-pressed={active}
        aria-label={ariaLabel || `Afficher ${label}`}
        className={rootClassName}
        style={{ ...rootStyle, "--tw-ring-color": theme.border } as CSSProperties}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={rootClassName} style={rootStyle}>
      {content}
    </div>
  );
}

export type SalesFilterOption = {
  value: string;
  label: string;
  count?: number;
  accent?: ModuleAccentTone;
};

export type SalesPeriodPreset =
  | "current_month"
  | "previous_month"
  | "last_30_days"
  | "current_quarter"
  | "current_year"
  | "custom_month";

export type SalesPeriodRange = {
  start: string;
  end: string;
  label: string;
};

export const salesPeriodOptions: { value: SalesPeriodPreset; label: string }[] = [
  { value: "current_month", label: "Ce mois" },
  { value: "previous_month", label: "Mois précédent" },
  { value: "last_30_days", label: "30 jours" },
  { value: "current_quarter", label: "Trimestre" },
  { value: "current_year", label: "Année" },
  { value: "custom_month", label: "Mois précis" },
];

function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

export function toSalesDateInputValue(value: Date) {
  return `${value.getFullYear()}-${twoDigits(value.getMonth() + 1)}-${twoDigits(value.getDate())}`;
}

export function toSalesMonthInputValue(value: Date) {
  return `${value.getFullYear()}-${twoDigits(value.getMonth() + 1)}`;
}

export function getSalesMonthRange(monthValue: string): SalesPeriodRange {
  const fallback = toSalesMonthInputValue(new Date());
  const [yearRaw, monthRaw] = (monthValue || fallback).split("-");
  const year = Number(yearRaw) || new Date().getFullYear();
  const monthIndex = Math.min(11, Math.max(0, (Number(monthRaw) || 1) - 1));
  const start = new Date(year, monthIndex, 1);
  const end = new Date(year, monthIndex + 1, 0);
  const label = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(start);
  return { start: toSalesDateInputValue(start), end: toSalesDateInputValue(end), label };
}

export function getSalesPeriodRange(period: SalesPeriodPreset, selectedMonth: string): SalesPeriodRange {
  const today = new Date();
  if (period === "previous_month") {
    return getSalesMonthRange(toSalesMonthInputValue(new Date(today.getFullYear(), today.getMonth() - 1, 1)));
  }
  if (period === "last_30_days") {
    const start = new Date(today);
    start.setDate(start.getDate() - 29);
    return {
      start: toSalesDateInputValue(start),
      end: toSalesDateInputValue(today),
      label: "30 derniers jours",
    };
  }
  if (period === "current_quarter") {
    const quarterIndex = Math.floor(today.getMonth() / 3);
    const start = new Date(today.getFullYear(), quarterIndex * 3, 1);
    const end = new Date(today.getFullYear(), quarterIndex * 3 + 3, 0);
    return {
      start: toSalesDateInputValue(start),
      end: toSalesDateInputValue(end),
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
    return getSalesMonthRange(selectedMonth);
  }
  return getSalesMonthRange(toSalesMonthInputValue(today));
}

export function SalesPeriodControl({
  tone,
  value,
  onChange,
  monthValue,
  onMonthChange,
  options = salesPeriodOptions,
  ariaLabel = "Période des indicateurs",
  monthAriaLabel = "Mois des indicateurs",
}: {
  tone: ModuleThemeTone;
  value: string;
  onChange: (nextValue: string) => void;
  monthValue?: string;
  onMonthChange?: (nextValue: string) => void;
  options?: { value: string; label: string }[];
  ariaLabel?: string;
  monthAriaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const theme = getModuleTheme(tone);
  const selectedOption = options.find((option) => option.value === value) || options[0];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="pf-filter-button inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-transparent px-3 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
            data-active={open ? "true" : undefined}
            style={
              {
                background: theme.soft,
                color: theme.strong,
                fontSize: "var(--pf-app-text-body, 0.8125rem)",
                fontWeight: 700,
                "--pf-module-soft": theme.soft,
                "--pf-module-strong": theme.strong,
                "--pf-module-border": theme.border,
                "--tw-ring-color": theme.border,
              } as CSSProperties
            }
            aria-label={ariaLabel}
          >
            <CalendarDays className="h-3.5 w-3.5" />
            <span className="whitespace-nowrap">{selectedOption?.label || "Période"}</span>
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="min-w-[12rem] rounded-xl border bg-white p-1.5 shadow-xl"
          style={{
            borderColor: `${theme.border}99`,
            boxShadow: `0 18px 36px -24px ${theme.strong}88, 0 8px 18px rgba(15,23,42,0.08)`,
          }}
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <DropdownMenuItem
                key={option.value}
                onSelect={() => onChange(option.value)}
                className="flex h-8 cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 text-[#334155] transition-colors focus:bg-[#f8fafc] focus:text-[#0f172a]"
                style={{
                  background: active ? theme.soft : undefined,
                  color: active ? theme.strong : undefined,
                  fontSize: "var(--pf-app-text-body, 0.8125rem)",
                  fontWeight: active ? 800 : 600,
                }}
              >
                <span>{option.label}</span>
                {active ? <Check className="h-3.5 w-3.5" style={{ color: theme.strong }} /> : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {value === "custom_month" && monthValue != null && onMonthChange ? (
        <div
          className="pf-filter-button inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-transparent px-3 transition-all"
          style={
            {
              color: theme.strong,
              background: theme.soft,
              "--pf-module-soft": theme.soft,
              "--pf-module-strong": theme.strong,
              "--pf-module-border": theme.border,
              "--tw-ring-color": theme.border,
            } as CSSProperties
          }
        >
          <CalendarDays className="h-3.5 w-3.5" />
          <input
            type="month"
            value={monthValue}
            onChange={(event) => onMonthChange(event.target.value || toSalesMonthInputValue(new Date()))}
            className="h-full bg-transparent outline-none"
            style={{
              color: theme.strong,
              fontSize: "var(--pf-app-text-body, 0.8125rem)",
              fontWeight: 700,
            }}
            aria-label={monthAriaLabel}
          />
        </div>
      ) : null}
    </div>
  );
}

export function SalesSearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  density = "client",
  tone,
  width,
  onClear,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel?: string;
  density?: SalesDensity;
  tone?: ModuleThemeTone;
  width?: string;
  onClear?: () => void;
}) {
  const theme = tone ? getModuleTheme(tone) : null;
  const isClientDensity = density === "client";

  return (
    <div
      className={`flex min-w-0 items-center gap-2 transition-[border-color,box-shadow] ${
        isClientDensity ? "w-full rounded-lg px-3 py-1.5 sm:w-auto" : "w-full min-h-[54px] rounded-[18px] bg-white px-4"
      } border border-[#dbe5ef] focus-within:border-[#c8d6ea]`}
      style={{
        maxWidth: width || (isClientDensity ? "18rem" : "28rem"),
        background: isClientDensity ? "#f8fafc" : "#ffffff",
        borderColor: isClientDensity ? "#e9eef4" : theme ? `${theme.border}aa` : "#dbe5ef",
        boxShadow: isClientDensity
          ? "none"
          : theme
            ? `0 1px 2px rgba(15,23,42,0.04), 0 0 0 4px ${theme.soft}`
            : "0 1px 2px rgba(15,23,42,0.04)",
      }}
    >
      <Search
        className={`${isClientDensity ? "h-3.5 w-3.5" : "h-4 w-4"} flex-shrink-0`}
        style={{ color: isClientDensity ? "#94a3b8" : theme ? theme.strong : "#94a3b8" }}
      />
      <input
        aria-label={ariaLabel || placeholder || "Rechercher"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[#334155] outline-none placeholder:text-[#94a3b8]"
        style={{
          fontSize: "var(--pf-app-text-body)",
          fontWeight: isClientDensity ? 500 : 550,
        }}
      />
      {value ? (
        <button
          type="button"
          onClick={() => (onClear ? onClear() : onChange(""))}
          className="flex-shrink-0 text-[#94a3b8] transition-colors hover:text-[#475569]"
          aria-label="Effacer la recherche"
        >
          <X className={`${isClientDensity ? "h-3.5 w-3.5" : "h-4 w-4"}`} />
        </button>
      ) : null}
    </div>
  );
}

export function SalesListBlock({
  tone,
  density = "client",
  filters,
  filterValue,
  onFilterChange,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchWidth,
  leftExtras,
  rightExtras,
  children,
}: {
  tone: ModuleThemeTone;
  density?: SalesDensity;
  filters?: SalesFilterOption[];
  filterValue?: string;
  onFilterChange?: (value: string) => void;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  searchWidth?: string;
  leftExtras?: ReactNode;
  rightExtras?: ReactNode;
  children: ReactNode;
}) {
  const theme = getModuleTheme(tone);
  const hasHeader =
    (filters && filters.length > 0 && filterValue != null && onFilterChange) ||
    leftExtras ||
    rightExtras ||
    (typeof searchValue === "string" && onSearchChange && searchPlaceholder);

  return (
    <div
      className="pf-list-card overflow-hidden bg-white"
      style={
        {
          boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)",
          "--pf-module-accent": theme.accent,
          "--pf-module-soft": theme.soft,
          "--pf-module-strong": theme.strong,
          "--pf-module-border": theme.border,
        } as CSSProperties
      }
    >
      {hasHeader ? (
        <div
          className="pf-list-toolbar flex flex-col justify-between gap-3 px-4 py-3 sm:flex-row sm:items-center"
          style={{ borderBottom: "1px solid #f1f5f9" }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {filters && filters.length > 0 && filterValue != null && onFilterChange ? (
              <SalesFilterRail
                options={filters}
                value={filterValue}
                onChange={onFilterChange}
                tone={tone}
                density={density}
              />
            ) : null}
          </div>
          <div className="pf-toolbar-actions flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-nowrap sm:items-center sm:justify-end">
            {leftExtras ? <div className="flex flex-shrink-0 items-center gap-2">{leftExtras}</div> : null}
            {typeof searchValue === "string" && onSearchChange && searchPlaceholder ? (
              <SalesSearchField
                value={searchValue}
                onChange={onSearchChange}
                placeholder={searchPlaceholder}
                density={density}
                tone={tone}
                width={searchWidth}
              />
            ) : null}
            {rightExtras}
          </div>
        </div>
      ) : null}
      {children}
    </div>
  );
}

function SalesFilterRail({
  options,
  value,
  onChange,
  tone,
  density,
}: {
  options: SalesFilterOption[];
  value: string;
  onChange: (nextValue: string) => void;
  tone: ModuleThemeTone;
  density?: SalesDensity;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const maxScrollLeft = Math.max(0, rail.scrollWidth - rail.clientWidth);
    setCanScrollLeft(rail.scrollLeft > 2);
    setCanScrollRight(rail.scrollLeft < maxScrollLeft - 2);
  }, []);

  useEffect(() => {
    updateScrollState();
    const rail = railRef.current;
    if (!rail) return;
    rail.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateScrollState) : null;
    observer?.observe(rail);
    return () => {
      rail.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
      observer?.disconnect();
    };
  }, [options.length, updateScrollState, value]);

  const scrollRail = (direction: "left" | "right") => {
    const rail = railRef.current;
    if (!rail) return;
    const distance = Math.max(180, Math.floor(rail.clientWidth * 0.72));
    rail.scrollBy({ left: direction === "right" ? distance : -distance, behavior: "smooth" });
  };

  return (
    <div className="pf-filter-rail relative flex min-w-0 flex-1 items-center gap-1">
      {canScrollLeft ? (
        <button
          type="button"
          className="pf-filter-scroll-button pf-filter-scroll-button--left"
          onClick={() => scrollRail("left")}
          aria-label="Voir les filtres précédents"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <div
        ref={railRef}
        className="pf-filter-tabs pf-filter-tabs-scroll flex min-w-0 flex-1 flex-nowrap items-center gap-0.5 overflow-x-auto"
      >
        <SalesFilterPills options={options} value={value} onChange={onChange} tone={tone} density={density} />
      </div>
      {canScrollRight ? (
        <button
          type="button"
          className="pf-filter-scroll-button pf-filter-scroll-button--right"
          onClick={() => scrollRail("right")}
          aria-label="Voir les filtres suivants"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export function SalesToolbar({
  searchValue,
  searchPlaceholder,
  onSearchChange,
  extra,
  tone,
  density = "default",
}: {
  searchValue: string;
  searchPlaceholder: string;
  onSearchChange: (value: string) => void;
  extra?: ReactNode;
  tone?: ModuleThemeTone;
  density?: SalesDensity;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SalesSearchField
          value={searchValue}
          onChange={onSearchChange}
          placeholder={searchPlaceholder}
          density={density}
          tone={tone}
        />
        {extra ? <div className="flex flex-wrap items-center gap-2 lg:justify-end">{extra}</div> : null}
      </div>
    </div>
  );
}

export function SalesFilterPills({
  options,
  value,
  onChange,
  tone,
  density = "default",
}: {
  options: SalesFilterOption[];
  value: string;
  onChange: (nextValue: string) => void;
  tone: ModuleThemeTone;
  density?: SalesDensity;
}) {
  const isClientDensity = density === "client";

  return (
    <>
      {options.map((option) => {
        const active = option.value === value;
        const theme = resolveModuleTheme(tone, option.accent || "module");
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`pf-filter-pill inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap border transition-colors ${
              isClientDensity ? "rounded-lg px-3 py-1.5" : "rounded-xl px-3 py-2"
            }`}
            style={{
              borderColor: active ? theme.accent : "transparent",
              background: active ? (isClientDensity ? theme.gradient : theme.soft) : "#ffffff",
              color: active ? (isClientDensity ? "#ffffff" : theme.strong) : "#64748b",
              fontSize: "var(--pf-app-text-body)",
              fontWeight: active ? 600 : 400,
              boxShadow: active && isClientDensity ? "0 1px 4px rgba(15,23,42,0.08)" : "none",
            }}
          >
            <span>{option.label}</span>
            {typeof option.count === "number" ? (
              <span
                className="rounded-full px-1.5 py-0.5"
                style={{
                  background: active ? (isClientDensity ? "rgba(255,255,255,0.22)" : `${theme.accent}18`) : "#f1f5f9",
                  color: active ? (isClientDensity ? "#ffffff" : theme.strong) : "#94a3b8",
                  fontSize: "var(--pf-app-text-overline)",
                  fontWeight: 700,
                }}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </>
  );
}
