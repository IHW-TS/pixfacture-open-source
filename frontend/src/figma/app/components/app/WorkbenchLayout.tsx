"use client";

import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { Link } from "@/figma/react-router-compat";
import { Card, StatusPill } from "./AppPageHeader";
import { getModuleTheme, type ModuleThemeTone } from "./SalesModuleLayout";

type HeroTone = "blue" | "purple" | "green" | "slate";
type AccentTone = "blue" | "green" | "amber" | "purple" | "cyan" | "red";

type WorkbenchMetric = {
  label: string;
  value: string | number;
  detail?: string;
  accent?: AccentTone;
  icon?: ReactNode;
};

type WorkbenchChip = {
  label: string;
  status?: "ok" | "warn" | "danger" | "muted" | "info" | "purple";
};

type WorkbenchQuickLink = {
  href: string;
  label: string;
  icon?: ReactNode;
  active?: boolean;
};

const metricAccentStyles: Record<AccentTone, { bar: string; iconBg: string; iconColor: string }> = {
  blue: { bar: "#2563eb", iconBg: "#eff6ff", iconColor: "#2563eb" },
  green: { bar: "#16a34a", iconBg: "#ecfdf5", iconColor: "#16a34a" },
  amber: { bar: "#d97706", iconBg: "#fffbeb", iconColor: "#d97706" },
  purple: { bar: "#7c3aed", iconBg: "#f5f3ff", iconColor: "#7c3aed" },
  cyan: { bar: "#0891b2", iconBg: "#ecfeff", iconColor: "#0891b2" },
  red: { bar: "#dc2626", iconBg: "#fef2f2", iconColor: "#dc2626" },
};

export function WorkbenchPage({ children, maxWidth = "none" }: { children: ReactNode; maxWidth?: string }) {
  return (
    <div
      data-testid="workbench-page"
      className="w-full space-y-3 p-4 lg:p-5"
      style={{ maxWidth, margin: maxWidth === "none" ? 0 : "0 auto" }}
    >
      {children}
    </div>
  );
}

export function WorkbenchHero({
  eyebrow,
  title,
  description,
  theme,
  chips = [],
  metrics = [],
  quickLinks = [],
}: {
  eyebrow: string;
  title: string;
  description: string;
  tone?: HeroTone;
  theme?: ModuleThemeTone;
  chips?: WorkbenchChip[];
  metrics?: WorkbenchMetric[];
  quickLinks?: WorkbenchQuickLink[];
  aside?: ReactNode;
}) {
  const moduleTheme = theme ? getModuleTheme(theme) : null;
  const visibleChips = chips.slice(0, 2);
  const visibleQuickLinks = quickLinks.slice(0, 2);
  const visibleMetrics = metrics.slice(0, 3);
  const quickLinkActiveStyle = moduleTheme
    ? {
        borderColor: moduleTheme.accent,
        background: moduleTheme.gradient,
        color: "#ffffff",
        boxShadow: `0 8px 18px -16px ${moduleTheme.accent}aa`,
      }
    : undefined;
  const quickLinkIdleStyle = moduleTheme
    ? {
        borderColor: moduleTheme.border,
        color: moduleTheme.strong,
      }
    : undefined;

  return (
    <div className="space-y-3">
      {title || description || visibleChips.length > 0 || visibleQuickLinks.length > 0 ? (
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            {eyebrow ? (
              <div className="inline-flex rounded-full border border-[#d7e3ef] bg-white/92 px-2.5 py-1 text-[0.625rem] font-bold uppercase tracking-[0.08em] text-[#6f8298]">
                {eyebrow}
              </div>
            ) : null}
            {title ? (
              <h2 className="mt-2 text-[1rem] font-[760] tracking-[-0.04em] text-[#0f172a] lg:text-[1.08rem]">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="mt-1 max-w-3xl text-[0.76rem] leading-5 text-[#607389]">{description}</p>
            ) : null}
          </div>

          {visibleChips.length > 0 || visibleQuickLinks.length > 0 ? (
            <div className="flex flex-col gap-2 lg:items-end">
              {visibleChips.length > 0 ? (
                <div className="flex flex-wrap gap-2 lg:justify-end">
                  {visibleChips.map((chip) => (
                    <StatusPill key={chip.label} color={chip.status || "muted"} label={chip.label} />
                  ))}
                </div>
              ) : null}

              {visibleQuickLinks.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  {visibleQuickLinks.map((item) => (
                    <Link
                      key={item.href}
                      to={item.href}
                      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 transition-colors ${
                        item.active
                          ? "text-white"
                          : "border-[#d7e3ef] bg-white text-[#475569] hover:border-[#bfdbfe] hover:text-[#1d4ed8]"
                      }`}
                      style={{
                        fontSize: "0.72rem",
                        fontWeight: 700,
                        ...(item.active ? quickLinkActiveStyle : quickLinkIdleStyle),
                      }}
                    >
                      {item.icon}
                      {item.label}
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {visibleMetrics.length > 0 ? (
        <div
          className={`grid gap-3 ${visibleMetrics.length === 1 ? "md:grid-cols-1" : visibleMetrics.length === 2 ? "md:grid-cols-2" : "md:grid-cols-3"}`}
        >
          {visibleMetrics.map((metric) => {
            const accent = metricAccentStyles[metric.accent || "blue"];
            return (
              <div
                key={metric.label}
                className="relative overflow-hidden rounded-2xl bg-white px-4 py-3.5 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_8px_24px_rgba(0,0,0,0.04)]"
              >
                <div className="absolute left-0 right-0 top-0 h-[3px]" style={{ background: accent.bar }} />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[0.63rem] font-bold uppercase tracking-[0.1em] text-[#8ea0b5]">
                    {metric.label}
                  </span>
                  {metric.icon ? (
                    <div
                      className="flex h-8 w-8 items-center justify-center rounded-xl"
                      style={{ background: accent.iconBg, color: accent.iconColor }}
                    >
                      {metric.icon}
                    </div>
                  ) : null}
                </div>
                <div className="mt-2 text-[1.45rem] font-[800] tracking-[-0.03em] text-[#0f172a]">{metric.value}</div>
                {metric.detail ? <div className="mt-1.5 text-[0.73rem] text-[#94a3b8]">{metric.detail}</div> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function WorkbenchAsideCard({
  eyebrow,
  title,
  description,
  href,
  ctaLabel = "Ouvrir",
  stats = [],
  theme,
}: {
  eyebrow: string;
  title: string;
  description: string;
  href?: string;
  ctaLabel?: string;
  stats?: Array<{ label: string; value: string | number }>;
  theme?: ModuleThemeTone;
}) {
  const moduleTheme = theme ? getModuleTheme(theme) : null;
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-[#94a3b8]">{eyebrow}</div>
          <h3 className="mt-1 text-[0.92rem] font-[740] tracking-[-0.02em] text-[#0f172a]">{title}</h3>
          <p className="mt-1 text-[0.76rem] leading-5 text-[#64748b]">{description}</p>
        </div>
        <div
          className="rounded-xl p-2"
          style={
            moduleTheme
              ? { background: moduleTheme.soft, color: moduleTheme.strong }
              : { background: "#eff6ff", color: "#2563eb" }
          }
        >
          <ArrowUpRight className="h-4 w-4" />
        </div>
      </div>

      {stats.length > 0 ? (
        <div className={`mt-4 grid gap-3 ${stats.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
          {stats.map((item) => (
            <div
              key={item.label}
              className="rounded-xl border px-3 py-2.5"
              style={
                moduleTheme
                  ? { background: `${moduleTheme.soft}cc`, borderColor: moduleTheme.border }
                  : { background: "#f8fafc", borderColor: "#e2e8f0" }
              }
            >
              <div className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-[#94a3b8]">
                {item.label}
              </div>
              <div className="mt-1 text-[1.125rem] font-[760] text-[#0f172a]">{item.value}</div>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );

  return (
    <Card
      className="w-full border"
      style={moduleTheme ? { borderColor: moduleTheme.border } : { borderColor: "#dce5ef" }}
    >
      {href ? (
        <Link to={href} className="block transition-opacity hover:opacity-95">
          {body}
          <div
            className="mt-4 inline-flex items-center gap-2 text-[0.75rem] font-semibold"
            style={moduleTheme ? { color: moduleTheme.strong } : { color: "#1d4ed8" }}
          >
            {ctaLabel}
            <ArrowUpRight className="h-3.5 w-3.5" />
          </div>
        </Link>
      ) : (
        body
      )}
    </Card>
  );
}

export function WorkbenchSection({
  eyebrow,
  title,
  description,
  controls,
  children,
  footer,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  controls?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card padding={false} className="overflow-hidden bg-white">
      <div className="border-b border-[#eef2f7] px-4 py-3 lg:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            {eyebrow ? (
              <div className="text-[0.625rem] font-bold uppercase tracking-[0.1em] text-[#9aa9bc]">{eyebrow}</div>
            ) : null}
            <h3 className="mt-1 text-[0.9375rem] font-[740] tracking-[-0.02em] text-[#0f172a]">{title}</h3>
            {description ? <p className="mt-1 text-[0.78rem] leading-5 text-[#64748b]">{description}</p> : null}
          </div>
          {controls ? <div className="flex flex-wrap items-center gap-2">{controls}</div> : null}
        </div>
      </div>
      <div className="px-4 py-3 lg:px-5">{children}</div>
      {footer ? <div className="border-t border-[#eef2f7] px-4 py-2 lg:px-5">{footer}</div> : null}
    </Card>
  );
}
