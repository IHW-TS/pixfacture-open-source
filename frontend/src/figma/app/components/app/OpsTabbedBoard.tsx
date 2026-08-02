"use client";

import type { ChangeEventHandler, ReactNode } from "react";
import { ChevronDown, Search, X } from "lucide-react";

type OpsAccent = "blue" | "green" | "amber" | "red" | "purple" | "slate";

const MINI_STAT_TONES: Record<OpsAccent, { border: string; bg: string; text: string }> = {
  blue: { border: "#bfdbfe", bg: "#eff6ff", text: "#1d4ed8" },
  green: { border: "#bbf7d0", bg: "#f0fdf4", text: "#15803d" },
  amber: { border: "#fde68a", bg: "#fffbeb", text: "#b45309" },
  red: { border: "#fecaca", bg: "#fef2f2", text: "#b91c1c" },
  purple: { border: "#ddd6fe", bg: "#f5f3ff", text: "#6d28d9" },
  slate: { border: "#e2e8f0", bg: "#f8fafc", text: "#475569" },
};

export function OpsPanelShell<T extends string>({
  tabs,
  activeTab,
  onTabChange,
  headerActions,
  children,
  footer,
}: {
  tabs: Array<{
    id: T;
    label: string;
    badge?: number | string;
    activeHint?: string;
    submenuItems?: Array<{
      label: string;
      badge?: number | string;
      active?: boolean;
      onSelect: () => void;
    }>;
  }>;
  activeTab: T;
  onTabChange: (tab: T) => void;
  headerActions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div
      className="overflow-hidden rounded-2xl bg-white"
      style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)" }}
    >
      <div
        className="flex flex-col justify-between gap-3 px-4 py-3 sm:flex-row sm:items-center"
        style={{ borderBottom: "1px solid #f1f5f9" }}
      >
        <div className="flex flex-wrap items-center gap-0.5">
          {tabs.map((tab) => {
            const active = tab.id === activeTab;
            const hasSubmenu = Boolean(tab.submenuItems?.length);
            return (
              <div key={tab.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onTabChange(tab.id)}
                  className="relative z-30 flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition-all"
                  style={{
                    fontSize: "0.8125rem",
                    fontWeight: active ? 600 : 400,
                    background: active ? "linear-gradient(135deg,#2563eb 0%,#4f46e5 100%)" : "transparent",
                    color: active ? "#ffffff" : "#64748b",
                    boxShadow: active ? "0 1px 4px rgba(37,99,235,0.2)" : "none",
                  }}
                >
                  <span>{tab.label}</span>
                  {tab.badge !== undefined ? (
                    <span
                      className="inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full px-1.5"
                      style={{
                        fontSize: "0.625rem",
                        fontWeight: 700,
                        background: active ? "rgba(255,255,255,0.22)" : "#f1f5f9",
                        color: active ? "#ffffff" : "#94a3b8",
                      }}
                    >
                      {tab.badge}
                    </span>
                  ) : null}
                  {tab.activeHint ? (
                    <span
                      className="hidden md:inline"
                      style={{
                        fontSize: "0.75rem",
                        fontWeight: 500,
                        color: active ? "rgba(255,255,255,0.78)" : "#94a3b8",
                      }}
                    >
                      {tab.activeHint}
                    </span>
                  ) : null}
                  {hasSubmenu ? (
                    <ChevronDown className="h-3.5 w-3.5" style={{ color: active ? "#ffffff" : "#94a3b8" }} />
                  ) : null}
                </button>

                {hasSubmenu ? (
                  <div
                    className="pointer-events-none absolute left-0 z-20 hidden min-w-full group-hover:block group-focus-within:block"
                    style={{ top: "calc(100% + 4px)" }}
                  >
                    <div className="pointer-events-auto relative" style={{ width: "100%" }}>
                      <div className="relative space-y-1 rounded-2xl border border-[#e5edf6] bg-white p-2 shadow-[0_18px_48px_-28px_rgba(15,23,42,0.35)]">
                        {(tab.submenuItems || []).map((item) => (
                          <button
                            key={`${tab.id}-${item.label}`}
                            type="button"
                            onClick={item.onSelect}
                            className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left transition-colors ${
                              item.active
                                ? "bg-[#eef2ff] text-[#1d4ed8]"
                                : "text-[#475569] hover:bg-[#f8fafc] hover:text-[#0f172a]"
                            }`}
                            style={{ fontSize: "0.8125rem", fontWeight: item.active ? 700 : 500 }}
                          >
                            <span className="min-w-0 flex-1 leading-snug">{item.label}</span>
                            {item.badge !== undefined ? (
                              <span
                                className={`ml-2 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[0.6875rem] font-bold ${
                                  item.active ? "bg-white text-[#1d4ed8]" : "bg-[#f1f5f9] text-[#64748b]"
                                }`}
                              >
                                {item.badge}
                              </span>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {headerActions ? <div className="flex flex-wrap items-center gap-2">{headerActions}</div> : null}
      </div>
      <div className="p-5">{children}</div>
      {footer ? <div className="border-t border-[#f1f5f9] px-5 py-3">{footer}</div> : null}
    </div>
  );
}

export function OpsSearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className = "",
  onClear,
}: {
  value: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
  placeholder: string;
  ariaLabel?: string;
  className?: string;
  onClear?: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-lg px-3 py-1.5 ${className}`}
      style={{
        background: "#f8fafc",
        border: "1px solid #e9eef4",
        minHeight: "2.1875rem",
      }}
    >
      <Search className="h-3.5 w-3.5 flex-shrink-0 text-[#94a3b8]" />
      <input
        aria-label={ariaLabel || placeholder || "Rechercher"}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="w-full bg-transparent text-[#374151] outline-none placeholder:text-[#94a3b8]"
        style={{ fontSize: "0.8125rem" }}
      />
      {value ? (
        <button
          type="button"
          onClick={() => (onClear ? onClear() : onChange({ target: { value: "" } } as any))}
          className="flex-shrink-0 text-[#94a3b8] transition-colors hover:text-[#475569]"
          aria-label="Effacer la recherche"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export function OpsFilterChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-[0.8125rem] transition-all ${
        active
          ? "border-transparent text-white shadow-[0_12px_24px_-18px_rgba(79,70,229,0.8)]"
          : "border-[#dbe5ef] bg-white text-[#64748b] hover:border-[#c7d2fe] hover:bg-[#f8fafc] hover:text-[#334155]"
      }`}
      style={
        active
          ? {
              background: "linear-gradient(135deg,#2563eb 0%,#4f46e5 100%)",
              fontWeight: 700,
            }
          : { fontWeight: 500 }
      }
    >
      <span>{label}</span>
      {typeof count === "number" ? (
        <span
          className={`inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[0.6875rem] font-bold ${
            active ? "bg-white/20 text-white" : "bg-[#eef2ff] text-[#6366f1]"
          }`}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

export function OpsMiniStat({
  label,
  value,
  detail,
  accent = "slate",
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  accent?: OpsAccent;
}) {
  const tone = MINI_STAT_TONES[accent];

  return (
    <div className="rounded-xl border px-3 py-3" style={{ borderColor: tone.border, background: tone.bg }}>
      <div className="text-[0.625rem] font-bold uppercase tracking-[0.08em] text-[#94a3b8]">{label}</div>
      <div className="mt-2 text-[1.125rem] font-[800] leading-none text-[#0f172a]">{value}</div>
      {detail ? (
        <div className="mt-1.5 text-[0.75rem]" style={{ color: tone.text }}>
          {detail}
        </div>
      ) : null}
    </div>
  );
}

export function OpsEmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  secondaryAction?: ReactNode;
}) {
  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center rounded-2xl text-center">
      {icon ? (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#f4f7fb] text-[#cbd5e1]">
          {icon}
        </div>
      ) : null}
      <p className="text-[#374151]" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
        {title}
      </p>
      <p className="mt-2 max-w-md text-[#94a3b8]" style={{ fontSize: "0.8125rem", lineHeight: 1.6 }}>
        {description}
      </p>
      {action || secondaryAction ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
