"use client";

import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Minus,
  MoreHorizontal,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { CSSProperties, ElementType, HTMLAttributes } from "react";
import {
  Children,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  isValidElement,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { Link } from "@/figma/react-router-compat";
import { InlineHelpTooltip } from "./GuidanceTooltip";

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
                <ArrowLeft className="h-4 w-4" />
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
              <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-[#cbd5e1] sm:block" aria-hidden="true" />
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

type PillStatus = "ok" | "warn" | "danger" | "muted" | "info" | "purple";

export function StatusPill({ status, label, color }: { status?: PillStatus; label: string; color?: PillStatus }) {
  const key = status || color || "muted";
  const statusClass: Record<PillStatus, string> = {
    ok: "status-active",
    warn: "status-warning",
    danger: "status-danger",
    muted: "status-muted",
    info: "status-trial",
    purple: "status-muted",
  };
  const config: Record<PillStatus, { bg: string; text: string; dot: string; border: string }> = {
    ok: {
      bg: "#f0fdf4",
      text: "#166534",
      dot: "#22c55e",
      border: "#bbf7d0",
    },
    warn: {
      bg: "#fffbeb",
      text: "#92400e",
      dot: "#fbbf24",
      border: "#fde68a",
    },
    danger: {
      bg: "#fef2f2",
      text: "#b91c1c",
      dot: "#f87171",
      border: "#fecaca",
    },
    muted: {
      bg: "#f8fafc",
      text: "#475569",
      dot: "#cbd5e1",
      border: "#e2e8f0",
    },
    info: {
      bg: "#eff6ff",
      text: "#1d4ed8",
      dot: "#60a5fa",
      border: "#bfdbfe",
    },
    purple: {
      bg: "#f5f3ff",
      text: "#6d28d9",
      dot: "#a78bfa",
      border: "#ddd6fe",
    },
  };
  const tone = config[key];

  return (
    <span
      className={`status-pill ${statusClass[key]} inline-flex items-center gap-1.5 rounded-full px-2 py-0.5`}
      style={{
        fontSize: "var(--pf-app-text-body)",
        fontWeight: 600,
        background: tone.bg,
        color: tone.text,
        border: `1px solid ${tone.border}`,
      }}
    >
      <span className="h-[5px] w-[5px] flex-shrink-0 rounded-full" style={{ background: tone.dot }} />
      {label}
    </span>
  );
}

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
    blue: {
      iconBg: "#dbeafe",
      iconColor: "#1d4ed8",
      valueColor: "#0f172a",
      topBar: "#1d4ed8",
    },
    green: {
      iconBg: "#dcfce7",
      iconColor: "#16a34a",
      valueColor: "#0f172a",
      topBar: "#16a34a",
    },
    amber: {
      iconBg: "#fef3c7",
      iconColor: "#d97706",
      valueColor: "#0f172a",
      topBar: "#d97706",
    },
    red: {
      iconBg: "#fee2e2",
      iconColor: "#dc2626",
      valueColor: "#0f172a",
      topBar: "#dc2626",
    },
    purple: {
      iconBg: "#ede9fe",
      iconColor: "#7c3aed",
      valueColor: "#0f172a",
      topBar: "#7c3aed",
    },
    cyan: {
      iconBg: "#cffafe",
      iconColor: "#0891b2",
      valueColor: "#0f172a",
      topBar: "#0891b2",
    },
  };
  const tone = accent ? palette[accent] : null;

  return (
    <div
      className="relative overflow-hidden rounded-xl bg-white p-4 transition-all duration-200 hover:-translate-y-0.5"
      style={{
        boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)",
      }}
    >
      {tone ? (
        <div className="absolute left-0 right-0 top-0 h-[3px] rounded-t-2xl" style={{ background: tone.topBar }} />
      ) : null}

      <div className="mb-3 mt-0.5 flex items-start justify-between">
        <span
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
        {icon ? (
          <div
            className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${
              tone ? "" : "bg-[#f4f6fa] text-[#94a3b8]"
            }`}
            style={tone ? { background: tone.iconBg, color: tone.iconColor } : undefined}
          >
            {icon}
          </div>
        ) : null}
      </div>

      <div
        style={{
          fontSize: "var(--pf-app-text-value)",
          fontWeight: 800,
          letterSpacing: 0,
          lineHeight: 1,
          color: tone ? tone.valueColor : "#0f172a",
        }}
      >
        {value}
      </div>

      {sub || (trend && trendValue) ? (
        <div className="mt-2 flex items-center justify-between">
          {sub ? <span style={{ fontSize: "var(--pf-app-text-caption)", color: "#94a3b8" }}>{sub}</span> : <span />}
          {trend && trendValue ? (
            <div
              className="ml-auto flex items-center gap-1"
              style={{
                fontSize: "var(--pf-app-text-overline)",
                fontWeight: 600,
                color: trend === "up" ? "#16a34a" : trend === "down" ? "#dc2626" : "#94a3b8",
              }}
            >
              {trend === "up" ? (
                <TrendingUp className="h-3 w-3" />
              ) : trend === "down" ? (
                <TrendingDown className="h-3 w-3" />
              ) : (
                <Minus className="h-3 w-3" />
              )}
              {trendValue}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function PrimaryButton({
  children,
  className = "",
  style: extStyle,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  style?: React.CSSProperties;
}) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-white transition-all active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      style={{
        fontSize: "var(--pf-app-text-body)",
        fontWeight: 600,
        background: "linear-gradient(135deg,#1d4ed8 0%,#4f46e5 100%)",
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

export function PrimaryLinkButton({ to, children, className = "", style: extStyle, ...props }: any) {
  return (
    <Link
      to={to}
      className={`pf-button-link inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-white transition-all active:scale-[0.97] ${className}`}
      style={{
        fontSize: "var(--pf-app-text-body)",
        fontWeight: 600,
        background: "linear-gradient(135deg,#1d4ed8 0%,#4f46e5 100%)",
        color: "#ffffff",
        boxShadow: "0 1px 3px rgba(29,78,216,0.4), inset 0 1px 0 rgba(255,255,255,0.15)",
        ...extStyle,
      }}
      {...props}
    >
      {children}
    </Link>
  );
}

export function SecondaryButton({
  children,
  className = "",
  style: extStyle,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  style?: React.CSSProperties;
}) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-[#374151] transition-all active:scale-[0.97] hover:bg-[#f8fafc] disabled:opacity-50 ${className}`}
      style={{
        fontSize: "var(--pf-app-text-body)",
        fontWeight: 500,
        border: "1px solid rgba(0,0,0,0.08)",
        boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
        ...extStyle,
      }}
      {...props}
    >
      {children}
    </button>
  );
}

export function DangerButton({
  children,
  className = "",
  style: extStyle,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  style?: React.CSSProperties;
}) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-white transition-all active:scale-[0.97] disabled:opacity-50 ${className}`}
      style={{
        fontSize: "var(--pf-app-text-body)",
        fontWeight: 600,
        background: "linear-gradient(135deg,#dc2626,#ef4444)",
        boxShadow: "0 1px 3px rgba(220,38,38,0.35), inset 0 1px 0 rgba(255,255,255,0.12)",
        ...extStyle,
      }}
      {...props}
    >
      {children}
    </button>
  );
}

const ActionMenuContext = createContext<any>(null);
const ACTION_MENU_WIDTH = 208;
const ACTION_MENU_GAP = 6;

function actionItemBase(tone?: "default" | "danger") {
  return `flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
    tone === "danger" ? "text-[#dc2626] hover:bg-[#fef2f2]" : "text-[#374151] hover:bg-[#f8fafc]"
  }`;
}

export function ActionMenu({
  items,
  label: triggerLabel = "Plus",
  badge,
  children,
  className = "",
  align = "right",
  triggerVariant = "default",
  triggerIcon: TriggerIcon,
  iconOnly = false,
}: {
  items?: Array<{
    label: string;
    icon?: React.ElementType;
    onClick?: () => void;
    href?: string;
    danger?: boolean;
    divider?: boolean;
    tone?: "default" | "danger";
  }>;
  label?: string;
  badge?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  align?: "left" | "right";
  triggerVariant?: "default" | "success" | "primary" | "purple" | "orange";
  triggerIcon?: ElementType;
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const isColoredTrigger = triggerVariant !== "default";
  const triggerStyles: Record<"default" | "success" | "primary" | "purple" | "orange", React.CSSProperties> = {
    default: {
      background: "#fff",
      color: "#374151",
      border: "1px solid rgba(0,0,0,0.08)",
      boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
    },
    success: {
      background: "#15803d",
      color: "#fff",
      border: "1px solid rgba(21,128,61,0.72)",
      boxShadow: "0 1px 2px rgba(21,128,61,0.22)",
    },
    primary: {
      background: "#5B5EF4",
      color: "#fff",
      border: "1px solid rgba(91,94,244,0.72)",
      boxShadow: "0 2px 6px rgba(91,94,244,0.24)",
    },
    purple: {
      background: "#7c3aed",
      color: "#fff",
      border: "1px solid rgba(124,58,237,0.72)",
      boxShadow: "0 2px 6px rgba(124,58,237,0.24)",
    },
    orange: {
      background: "#f97316",
      color: "#fff",
      border: "1px solid rgba(234,88,12,0.72)",
      boxShadow: "0 2px 6px rgba(234,88,12,0.24)",
    },
  };

  const updateMenuPosition = useCallback(() => {
    const triggerRect = triggerRef.current?.getBoundingClientRect();
    if (!triggerRect) return;
    const menuHeight = menuRef.current?.offsetHeight || 0;
    let top = triggerRect.bottom + ACTION_MENU_GAP;
    if (menuHeight && top + menuHeight > window.innerHeight - 8) {
      top = Math.max(8, triggerRect.top - ACTION_MENU_GAP - menuHeight);
    }
    const rawLeft = align === "left" ? triggerRect.left : triggerRect.right - ACTION_MENU_WIDTH;
    const left = Math.max(8, Math.min(rawLeft, window.innerWidth - ACTION_MENU_WIDTH - 8));
    setMenuPosition({ top, left });
  }, [align]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target)) setOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const contextValue = useMemo(() => ({ close: () => setOpen(false) }), []);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }
    updateMenuPosition();
    const handleUpdate = () => updateMenuPosition();
    window.addEventListener("resize", handleUpdate);
    window.addEventListener("scroll", handleUpdate, true);
    return () => {
      window.removeEventListener("resize", handleUpdate);
      window.removeEventListener("scroll", handleUpdate, true);
    };
  }, [open, updateMenuPosition]);

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        aria-label={iconOnly ? triggerLabel : undefined}
        title={iconOnly ? triggerLabel : undefined}
        className={`inline-flex items-center justify-center gap-1.5 rounded-xl transition-all ${
          iconOnly ? "h-9 w-9 px-0 py-0" : "px-3 py-2"
        } ${isColoredTrigger ? "hover:brightness-95" : "hover:bg-[#f8fafc]"}`}
        style={{
          fontSize: "var(--pf-app-text-body)",
          fontWeight: isColoredTrigger ? 700 : 500,
          ...triggerStyles[triggerVariant],
        }}
      >
        {iconOnly && TriggerIcon ? (
          <TriggerIcon className="h-4 w-4" />
        ) : (
          <>
            {triggerLabel}
            {badge != null ? (
              <span
                className="inline-flex min-w-5 items-center justify-center rounded-full bg-white/18 px-1.5 text-center"
                style={{
                  fontSize: "0.6875rem",
                  fontWeight: 900,
                  lineHeight: 1.2,
                  color: isColoredTrigger ? "#fff" : "#475569",
                  background: isColoredTrigger ? "rgba(255,255,255,0.18)" : "#f1f5f9",
                }}
              >
                {badge}
              </span>
            ) : null}
            <ChevronDown
              className={`h-3.5 w-3.5 ${isColoredTrigger ? "text-white/80" : "text-[#94a3b8]"}`}
              style={{
                transform: open ? "rotate(180deg)" : undefined,
                transition: "transform 150ms",
              }}
            />
          </>
        )}
      </button>

      <AnimatePresence>
        {open ? (
          <ActionMenuContext.Provider value={contextValue}>
            <motion.div
              ref={menuRef}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1] }}
              className="fixed z-[1000] min-w-[208px] overflow-hidden rounded-xl bg-white py-1"
              style={{
                top: menuPosition?.top ?? 0,
                left: menuPosition?.left ?? 0,
                visibility: menuPosition ? "visible" : "hidden",
                boxShadow: "0 4px 24px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.06)",
              }}
            >
              {items
                ? items.map((item, index) => {
                    if (item.divider) {
                      return <ActionMenuSeparator key={`separator-${index}`} />;
                    }
                    const tone = item.tone || (item.danger ? "danger" : "default");
                    return item.href ? (
                      <ActionMenuLink
                        key={`${item.href}-${item.label}-${index}`}
                        to={item.href}
                        icon={item.icon}
                        tone={tone}
                      >
                        {item.label}
                      </ActionMenuLink>
                    ) : (
                      <ActionMenuButton
                        key={`${item.label}-${index}`}
                        icon={item.icon}
                        tone={tone}
                        onClick={item.onClick}
                      >
                        {item.label}
                      </ActionMenuButton>
                    );
                  })
                : children}
            </motion.div>
          </ActionMenuContext.Provider>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function ActionMenuButton({
  children,
  icon: Icon = MoreHorizontal,
  tone = "default",
  onClick,
  className = "",
  ...props
}: any) {
  const menu = useContext(ActionMenuContext);
  return (
    <button
      type="button"
      className={`${actionItemBase(tone)} ${className}`}
      style={{ fontSize: "var(--pf-app-text-body)" }}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
        menu?.close?.();
      }}
      {...props}
    >
      {Icon ? (
        <Icon
          className="h-4 w-4 flex-shrink-0"
          style={{ color: tone === "danger" ? "#dc2626" : "#64748b", strokeWidth: 1.8 }}
        />
      ) : null}
      <span>{children}</span>
    </button>
  );
}

export function ActionMenuLink({
  to,
  children,
  icon: Icon = MoreHorizontal,
  tone = "default",
  className = "",
  ...props
}: any) {
  const menu = useContext(ActionMenuContext);
  return (
    <Link
      to={to}
      className={`${actionItemBase(tone)} ${className}`}
      style={{ fontSize: "var(--pf-app-text-body)" }}
      onClick={(event) => {
        event.stopPropagation();
        menu?.close?.();
      }}
      {...props}
    >
      {Icon ? (
        <Icon
          className="h-4 w-4 flex-shrink-0"
          style={{ color: tone === "danger" ? "#dc2626" : "#64748b", strokeWidth: 1.8 }}
        />
      ) : null}
      <span>{children}</span>
    </Link>
  );
}

export function ActionMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="px-3 py-1.5 text-[#94a3b8]"
      style={{
        fontSize: "var(--pf-app-text-overline)",
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}
    >
      {children}
    </div>
  );
}

export function ActionMenuSeparator() {
  return <div className="my-1 border-t border-[#f1f5f9]" />;
}

export function InputField({
  label,
  required,
  hint,
  help,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  help?: React.ReactNode;
}) {
  const generatedId = useId();
  const inputId = props.id || `input-${generatedId.replace(/:/g, "")}`;

  return (
    <div>
      <label
        htmlFor={inputId}
        className="mb-1.5 flex items-center gap-1.5"
        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 500, color: "#374151" }}
      >
        <span>
          {label}
          {required ? <span className="ml-0.5 text-[#ef4444]">*</span> : null}
        </span>
        {help ? <InlineHelpTooltip content={help} className="h-4 w-4" /> : null}
      </label>
      <input
        id={inputId}
        className="w-full rounded-lg bg-white px-3 py-2 text-[#0f172a] placeholder:text-[#94a3b8] transition-all focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/25"
        style={{
          fontSize: "var(--pf-app-text-body)",
          border: "1px solid rgba(0,0,0,0.08)",
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        }}
        {...props}
      />
      {hint ? (
        <p className="mt-1.5 text-[#94a3b8]" style={{ fontSize: "var(--pf-app-text-caption)" }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function SelectField({
  label,
  required,
  children,
  help,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; help?: React.ReactNode }) {
  const generatedId = useId();
  const selectId = props.id || `select-${generatedId.replace(/:/g, "")}`;

  return (
    <div>
      <label
        htmlFor={selectId}
        className="mb-1.5 flex items-center gap-1.5"
        style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 500, color: "#374151" }}
      >
        <span>
          {label}
          {required ? <span className="ml-0.5 text-[#ef4444]">*</span> : null}
        </span>
        {help ? <InlineHelpTooltip content={help} className="h-4 w-4" /> : null}
      </label>
      <select
        id={selectId}
        className="w-full cursor-pointer appearance-none rounded-lg bg-white px-3 py-2 text-[#0f172a] transition-all focus:outline-none focus:ring-2 focus:ring-[#1d4ed8]/25"
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

export function DataTable({ headers, children }: { headers: string[]; children: React.ReactNode; empty?: string }) {
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
      className="overflow-hidden rounded-2xl bg-white"
      style={{
        boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)",
      }}
    >
      <div className="overflow-x-auto">
        <table className="pf-data-table w-full">
          <thead>
            <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
              {headers.map((header, index) => {
                const isTrailingAction = index === headers.length - 1 && /^actions?$/i.test(header.trim());
                return (
                  <th
                    key={`${header}-${index}`}
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
                      <button
                        type="button"
                        onClick={() => toggleSort(index)}
                        aria-label={`Trier par ${header}`}
                        aria-pressed={sortState?.index === index}
                        className={`group inline-flex items-center gap-1.5 transition-colors hover:text-[#ea580c] ${
                          sortState?.index === index ? "pf-sort-header-active text-[#ea580c]" : ""
                        }`}
                      >
                        <span>{header}</span>
                        {sortState?.index === index ? (
                          sortState.direction === "asc" ? (
                            <ArrowUp className="h-3 w-3 text-[#f97316]" aria-hidden="true" />
                          ) : (
                            <ArrowDown className="h-3 w-3 text-[#f97316]" aria-hidden="true" />
                          )
                        ) : (
                          <ArrowUpDown
                            className="h-3 w-3 text-[#cbd5e1] group-hover:text-[#f97316]"
                            aria-hidden="true"
                          />
                        )}
                      </button>
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

export function Card({
  children,
  className = "",
  padding = true,
  style,
  ...props
}: {
  children: React.ReactNode;
  className?: string;
  padding?: boolean;
  style?: CSSProperties;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={`rounded-2xl bg-white ${padding ? "px-4 py-3.5" : ""} ${className}`}
      style={{
        boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function DisclosureCard({
  title,
  description,
  badge,
  action,
  defaultOpen = false,
  collapsible = true,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  defaultOpen?: boolean;
  collapsible?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const visible = collapsible ? open : true;
  const headerInner = (
    <>
      <div className="min-w-0 flex-1">
        <div className="text-[#0f172a]" style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 700 }}>
          {title}
        </div>
        {description ? (
          <p className="mt-1 text-[#64748b]" style={{ fontSize: "var(--pf-app-text-caption)", lineHeight: 1.6 }}>
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        {badge}
        {action ? <div onClick={(event) => event.stopPropagation()}>{action}</div> : null}
        {collapsible ? (
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#f4f6fa] text-[#64748b]">
            <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
          </div>
        ) : null}
      </div>
    </>
  );

  return (
    <Card padding={false} className={className}>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-start justify-between gap-4 px-5 pb-3 pt-4 text-left"
          aria-expanded={open}
        >
          {headerInner}
        </button>
      ) : (
        <div className="flex items-start justify-between gap-4 px-5 pb-3 pt-4">{headerInner}</div>
      )}

      <AnimatePresence initial={false}>
        {visible ? (
          <motion.div
            initial={collapsible ? { opacity: 0, height: 0 } : false}
            animate={{ opacity: 1, height: "auto" }}
            exit={collapsible ? { opacity: 0, height: 0 } : undefined}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden px-5 pb-4"
          >
            <div className="border-t border-[#f1f5f9] pt-3">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </Card>
  );
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h3 style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 650, color: "#0d1117" }}>{children}</h3>
      {action}
    </div>
  );
}
