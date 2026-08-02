import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";
import { ArrowUpRight } from "lucide-react";
import { Card, StatusPill } from "./AppPageHeader";
import { getModuleTheme, type ModuleThemeTone } from "@/figma/app/components/app/SalesModuleLayout";

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

const heroToneStyles: Record<HeroTone, { background: string; border: string }> = {
  blue: {
    background:
      "radial-gradient(circle at top right, rgba(37,99,235,0.08), transparent 30%), linear-gradient(180deg,#fcfdff 0%,#f8fbff 100%)",
    border: "#dce5ef",
  },
  purple: {
    background:
      "radial-gradient(circle at top right, rgba(124,58,237,0.09), transparent 32%), linear-gradient(180deg,#fcfbff 0%,#f8f7ff 100%)",
    border: "#e5def4",
  },
  green: {
    background:
      "radial-gradient(circle at top right, rgba(22,163,74,0.08), transparent 32%), linear-gradient(180deg,#fbfffd 0%,#f7fdf9 100%)",
    border: "#d7eadf",
  },
  slate: {
    background:
      "radial-gradient(circle at top right, rgba(100,116,139,0.08), transparent 32%), linear-gradient(180deg,#fcfdff 0%,#f8fafc 100%)",
    border: "#dce4ee",
  },
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
  tone = "blue",
  theme,
  chips = [],
  metrics = [],
  quickLinks = [],
  aside,
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
  const toneStyle = moduleTheme
    ? {
        background: `linear-gradient(180deg,#ffffff 0%,${moduleTheme.soft} 100%)`,
        border: moduleTheme.border,
      }
    : heroToneStyles[tone];
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
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1.55fr)_300px]">
      <Card
        padding={false}
        className="overflow-hidden"
        style={{ borderColor: toneStyle.border, background: toneStyle.background } as CSSProperties}
      >
        <div className="px-5 py-5 lg:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-3xl">
              <div className="inline-flex rounded-full border border-[#d7e3ef] bg-white/92 px-2.5 py-1 text-[0.625rem] font-bold uppercase tracking-[0.08em] text-[#6f8298]">
                {eyebrow}
              </div>
              <h2 className="mt-2.5 text-[1.2rem] font-[780] tracking-[-0.035em] text-[#0f172a]">{title}</h2>
              <p className="mt-1.5 max-w-3xl text-[0.8125rem] leading-relaxed text-[#607389]">{description}</p>
            </div>
            {chips.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {chips.map((chip) => (
                  <StatusPill key={chip.label} color={chip.status || "muted"} label={chip.label} />
                ))}
              </div>
            ) : null}
          </div>

          {metrics.length > 0 ? (
            <div
              className={`mt-4 grid gap-3 ${metrics.length === 1 ? "md:grid-cols-1" : metrics.length === 2 ? "md:grid-cols-2" : "md:grid-cols-3"}`}
            >
              {metrics.map((metric) => {
                const accent = metricAccentStyles[metric.accent || "blue"];
                return (
                  <div
                    key={metric.label}
                    className="relative overflow-hidden rounded-xl bg-white px-3.5 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.06),0_8px_24px_rgba(0,0,0,0.04)]"
                  >
                    <div className="absolute left-0 right-0 top-0 h-[3px]" style={{ background: accent.bar }} />
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[0.65rem] font-bold uppercase tracking-[0.1em] text-[#8ea0b5]">
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
                    <div className="mt-2 text-[1.5rem] font-[800] tracking-[-0.03em] text-[#0f172a]">
                      {metric.value}
                    </div>
                    {metric.detail ? <div className="mt-2 text-[0.75rem] text-[#94a3b8]">{metric.detail}</div> : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {quickLinks.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {quickLinks.map((item) => (
                <Link
                  key={item.href}
                  to={item.href}
                  className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-2 transition-colors ${
                    item.active
                      ? "text-white"
                      : "border-[#d7e3ef] bg-white/92 text-[#475569] hover:border-[#bfdbfe] hover:text-[#1d4ed8]"
                  }`}
                  style={{
                    fontSize: "0.75rem",
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
      </Card>

      {aside ? <div className="space-y-3">{aside}</div> : null}
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
          <h3 className="mt-2 text-[1rem] font-[750] tracking-[-0.02em] text-[#0f172a]">{title}</h3>
          <p className="mt-1 text-[0.8125rem] leading-6 text-[#64748b]">{description}</p>
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
              className="rounded-xl px-3 py-2.5"
              style={moduleTheme ? { background: `${moduleTheme.soft}cc` } : { background: "#f8fafc" }}
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
    <Card>
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
