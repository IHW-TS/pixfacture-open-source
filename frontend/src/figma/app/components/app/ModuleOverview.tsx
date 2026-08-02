"use client";

import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Link } from "@/figma/react-router-compat";
import { Card, StatusPill } from "./AppPageHeader";

export type ModuleOverviewTone = "blue" | "green" | "amber" | "red" | "purple" | "cyan";

export type ModuleOverviewStat = {
  label: string;
  value: string | number;
  detail?: string;
  icon?: ReactNode;
  tone?: ModuleOverviewTone;
};

type ModuleOverviewFocus = {
  tone?: "ok" | "warn" | "danger" | "info" | "purple" | "muted";
  label?: string;
  title: string;
  description: string;
  href?: string;
  cta?: string;
};

const statToneClasses: Record<ModuleOverviewTone, string> = {
  blue: "border-[#d8e6ff] bg-[#f8fbff] text-[#2563eb]",
  green: "border-[#d5f3e2] bg-[#f3fdf8] text-[#059669]",
  amber: "border-[#f7e4c7] bg-[#fffaf0] text-[#c27a0a]",
  red: "border-[#f7d4d4] bg-[#fff5f5] text-[#dc2626]",
  purple: "border-[#eadfff] bg-[#faf7ff] text-[#7c3aed]",
  cyan: "border-[#d3f1f6] bg-[#f2fdff] text-[#0891b2]",
};

const statToneTopBars: Record<ModuleOverviewTone, string> = {
  blue: "linear-gradient(135deg,#2563eb 0%,#3b82f6 100%)",
  green: "linear-gradient(135deg,#16a34a 0%,#22c55e 100%)",
  amber: "linear-gradient(135deg,#f59e0b 0%,#fbbf24 100%)",
  red: "linear-gradient(135deg,#ef4444 0%,#f87171 100%)",
  purple: "linear-gradient(135deg,#7c3aed 0%,#8b5cf6 100%)",
  cyan: "linear-gradient(135deg,#0891b2 0%,#06b6d4 100%)",
};

const focusToneClasses: Record<
  NonNullable<ModuleOverviewFocus["tone"]>,
  { border: string; bg: string; text: string }
> = {
  ok: { border: "#bbf7d0", bg: "#f0fdf4", text: "#15803d" },
  warn: { border: "#fde68a", bg: "#fffbeb", text: "#b45309" },
  danger: { border: "#fecaca", bg: "#fef2f2", text: "#dc2626" },
  info: { border: "#bfdbfe", bg: "#eff6ff", text: "#1d4ed8" },
  purple: { border: "#ddd6fe", bg: "#f5f3ff", text: "#6d28d9" },
  muted: { border: "#cbd5e1", bg: "#f8fafc", text: "#475569" },
};

export function ModuleOverview({
  eyebrow,
  title,
  description,
  stats,
  focus,
  focusAction,
  compact = false,
  relaxedStats = false,
  maxStats,
  hideHeader = false,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  stats: ModuleOverviewStat[];
  focus?: ModuleOverviewFocus | null;
  focusAction?: ReactNode;
  compact?: boolean;
  relaxedStats?: boolean;
  maxStats?: number;
  hideHeader?: boolean;
}) {
  const visibleStats = stats.filter(Boolean).slice(0, maxStats ?? 4);

  if (compact) {
    const focusTone = focusToneClasses[focus?.tone || "info"];
    return (
      <div className="space-y-3">
        {!hideHeader ? (
          <div className="space-y-1.5">
            {eyebrow ? (
              <div className="inline-flex rounded-lg border border-[#d6e4f3] bg-white px-2.5 py-1 text-[0.5625rem] font-bold uppercase tracking-[0.08em] text-[#6f8298]">
                {eyebrow}
              </div>
            ) : null}
            <div className="max-w-3xl space-y-1">
              <h2 className="text-[1rem] font-[760] tracking-[-0.03em] text-[#0f172a] lg:text-[1.1rem]">{title}</h2>
              {description ? <p className="text-[0.78rem] leading-relaxed text-[#66788f]">{description}</p> : null}
            </div>
          </div>
        ) : null}

        {focus || focusAction ? (
          <div
            className="rounded-2xl border px-4 py-3 shadow-[0_1px_3px_rgba(15,23,42,0.04),0_10px_24px_rgba(15,23,42,0.04)]"
            style={{ borderColor: focusTone.border, background: focusTone.bg }}
          >
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {focus?.label ? <StatusPill status={focus.tone || "info"} label={focus.label} /> : null}
                  <div className="text-[0.9rem] font-[760] leading-snug tracking-[-0.02em] text-[#0f172a]">
                    {focus?.title || "Point d'attention"}
                  </div>
                </div>
                <p className="mt-1.5 text-[0.78rem] leading-relaxed text-[#64748b]">
                  {focus?.description ||
                    "Les résumés métier t'aident à voir où agir sans reconstituer l'état du business à la main."}
                </p>
              </div>
              {focusAction ? (
                <div className="flex-shrink-0">{focusAction}</div>
              ) : focus?.href && focus?.cta ? (
                <Link
                  to={focus.href}
                  className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-xl bg-[linear-gradient(135deg,#2563eb_0%,#1d4ed8_52%,#4338ca_100%)] px-3 py-2 text-[0.75rem] font-bold text-white shadow-[0_12px_22px_-16px_rgba(37,99,235,0.72)] transition-all hover:-translate-y-[1px]"
                >
                  {focus.cta}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}

        {visibleStats.length ? (
          <div
            className={`grid gap-3 ${visibleStats.length === 1 ? "md:grid-cols-1" : visibleStats.length === 2 ? "md:grid-cols-2" : visibleStats.length === 3 ? "md:grid-cols-3" : "md:grid-cols-2 xl:grid-cols-4"}`}
          >
            {visibleStats.map((stat) => {
              const tone = stat.tone || "blue";
              return (
                <div
                  key={stat.label}
                  className="overflow-hidden rounded-2xl bg-white"
                  style={{
                    border: "1px solid #dce5ef",
                    boxShadow: "0 1px 3px rgba(15,23,42,0.04), 0 16px 40px rgba(15,23,42,0.06)",
                  }}
                >
                  <div className="h-1.5 w-full" style={{ background: statToneTopBars[tone] }} />
                  <div
                    className={`flex items-start justify-between gap-4 ${
                      relaxedStats ? "min-h-[126px] px-4 py-4" : "min-h-[104px] px-4 py-3.5"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[0.65rem] font-bold uppercase tracking-[0.1em] text-[#90a0b4]">
                        {stat.label}
                      </div>
                      <div
                        className={`leading-none tracking-[-0.03em] text-[#0f172a] ${
                          relaxedStats ? "mt-4 text-[1.55rem] font-[720]" : "mt-3 text-[1.58rem] font-[780]"
                        }`}
                      >
                        {stat.value}
                      </div>
                      {stat.detail ? (
                        <div
                          className={`leading-relaxed text-[#8ea0bb] ${
                            relaxedStats ? "mt-2.5 text-[0.78rem]" : "mt-2 text-[0.75rem]"
                          }`}
                        >
                          {stat.detail}
                        </div>
                      ) : null}
                    </div>
                    {stat.icon ? (
                      <div
                        className={`flex flex-shrink-0 items-center justify-center rounded-2xl border ${
                          relaxedStats ? "h-12 w-12" : "h-10 w-10"
                        } ${statToneClasses[tone]}`}
                      >
                        {stat.icon}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Card padding={false} className="overflow-hidden">
      <div className="grid gap-0 xl:grid-cols-[1.28fr_0.72fr]">
        <div className="border-b border-[#e6eef6] bg-[radial-gradient(circle_at_top_left,_rgba(37,99,235,0.08),_transparent_34%),linear-gradient(180deg,#fbfdff_0%,#f5f9ff_100%)] px-5 py-5 lg:px-6 lg:py-6 xl:border-b-0 xl:border-r">
          {eyebrow ? (
            <div className="inline-flex rounded-full border border-[#d6e4f3] bg-white/88 px-3 py-1 text-[0.625rem] font-bold uppercase tracking-[0.12em] text-[#6f8298]">
              {eyebrow}
            </div>
          ) : null}

          <div className="mt-3 max-w-3xl">
            <h2 className="text-[1.35rem] font-[760] tracking-[-0.03em] text-[#0f172a] lg:text-[1.55rem]">{title}</h2>
            {description ? (
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#5f7187]">{description}</p>
            ) : null}
          </div>

          {visibleStats.length ? (
            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {visibleStats.map((stat) => {
                const tone = stat.tone || "blue";
                return (
                  <div
                    key={stat.label}
                    className="rounded-[20px] border border-[#dce5ef] bg-white/88 px-4 py-3 shadow-[0_14px_30px_-28px_rgba(15,23,42,0.38)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[0.66rem] font-bold uppercase tracking-[0.1em] text-[#90a0b4]">
                          {stat.label}
                        </div>
                        <div className="mt-1 text-[1.15rem] font-[760] tracking-[-0.02em] text-[#0f172a]">
                          {stat.value}
                        </div>
                        {stat.detail ? (
                          <div className="mt-1 text-xs leading-relaxed text-[#708197]">{stat.detail}</div>
                        ) : null}
                      </div>
                      {stat.icon ? (
                        <div
                          className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl border ${statToneClasses[tone]}`}
                        >
                          {stat.icon}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className="bg-[linear-gradient(180deg,#ffffff_0%,#fbfdff_100%)] px-5 py-5 lg:px-6 lg:py-6">
          <div className="flex h-full flex-col justify-between rounded-[24px] border border-[#dce5ef] bg-[linear-gradient(180deg,#ffffff_0%,#f9fbff_100%)] p-4 shadow-[0_16px_34px_-30px_rgba(15,23,42,0.35)]">
            <div>
              {focus?.label ? <StatusPill status={focus.tone || "info"} label={focus.label} /> : null}

              <div className="mt-3 text-[1.02rem] font-[760] leading-snug tracking-[-0.02em] text-[#0f172a]">
                {focus?.title || "Point d'attention"}
              </div>
              <p className="mt-2 text-sm leading-relaxed text-[#64748b]">
                {focus?.description ||
                  "Les résumés métier t'aident à voir où agir sans reconstituer l'état du business à la main."}
              </p>
            </div>

            {focusAction ? (
              <div className="mt-4">{focusAction}</div>
            ) : focus?.href && focus?.cta ? (
              <div className="mt-4">
                <Link
                  to={focus.href}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[linear-gradient(135deg,#2563eb_0%,#1d4ed8_52%,#4338ca_100%)] px-4 py-2.5 text-[0.8125rem] font-bold text-white shadow-[0_12px_22px_-16px_rgba(37,99,235,0.72)] transition-all hover:-translate-y-[1px]"
                >
                  {focus.cta}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  );
}
