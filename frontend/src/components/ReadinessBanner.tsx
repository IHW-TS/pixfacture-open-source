"use client";

import { AlertTriangle, CheckCircle2, ChevronRight } from "lucide-react";
import type { ReadinessNextAction } from "@/lib/readinessActions";

type ReadinessBannerProps = {
  title: string;
  readiness: any;
  nextAction: ReadinessNextAction;
  open: boolean;
  busy?: boolean;
  onToggle: () => void;
  onPrimaryAction: () => void;
  className?: string;
};

type NormalizedCheck = {
  id: string;
  label: string;
  message: string;
  severity: "blocking" | "warning" | "info";
  autoFixable: boolean;
};

const toneStyles: Record<string, { border: string; bg: string; icon: string; text: string; bar: string }> = {
  none: {
    border: "border-[#bbf7d0]",
    bg: "bg-[#ecfdf5]",
    icon: "text-[#059669]",
    text: "text-[#047857]",
    bar: "bg-[#10b981]",
  },
  success: {
    border: "border-[#bbf7d0]",
    bg: "bg-[#ecfdf5]",
    icon: "text-[#059669]",
    text: "text-[#047857]",
    bar: "bg-[#10b981]",
  },
  info: {
    border: "border-[#bfdbfe]",
    bg: "bg-[#eff6ff]",
    icon: "text-[#2563eb]",
    text: "text-[#1d4ed8]",
    bar: "bg-[#2563eb]",
  },
  warning: {
    border: "border-[#fed7aa]",
    bg: "bg-[#fff7ed]",
    icon: "text-[#c2410c]",
    text: "text-[#c2410c]",
    bar: "bg-[#f59e0b]",
  },
  danger: {
    border: "border-[#fecaca]",
    bg: "bg-[#fff1f2]",
    icon: "text-[#dc2626]",
    text: "text-[#b91c1c]",
    bar: "bg-[#dc2626]",
  },
};

const progressWidthClasses: Record<number, string> = {
  0: "w-[0%]",
  5: "w-[5%]",
  10: "w-[10%]",
  15: "w-[15%]",
  20: "w-[20%]",
  25: "w-[25%]",
  30: "w-[30%]",
  35: "w-[35%]",
  40: "w-[40%]",
  45: "w-[45%]",
  50: "w-[50%]",
  55: "w-[55%]",
  60: "w-[60%]",
  65: "w-[65%]",
  70: "w-[70%]",
  75: "w-[75%]",
  80: "w-[80%]",
  85: "w-[85%]",
  90: "w-[90%]",
  95: "w-[95%]",
  100: "w-full",
};

function progressWidthClass(score: number) {
  const bucket = Math.max(0, Math.min(100, Math.round(score / 5) * 5));
  return progressWidthClasses[bucket] || progressWidthClasses[0];
}

function normalizeCheck(check: any, index: number): NormalizedCheck {
  const rawSeverity = String(check?.severity || "").toLowerCase();
  const isOk = check?.ok === true || rawSeverity === "info";
  const severity = isOk ? "info" : rawSeverity === "blocking" || check?.required !== false ? "blocking" : "warning";
  return {
    id: String(check?.id || check?.code || check?.label || `check-${index}`),
    label: String(check?.label || "Contrôle"),
    message: String(check?.message || check?.hint || (isOk ? "Contrôle validé." : "À compléter.")),
    severity,
    autoFixable: Boolean(check?.autoFixable ?? check?.auto_fixable),
  };
}

function groupChecks(checks: NormalizedCheck[]) {
  return {
    blocking: checks.filter((check) => check.severity === "blocking"),
    advice: checks.filter((check) => check.severity === "warning"),
    manual: checks.filter((check) => check.severity !== "info"),
  };
}

function CheckGroup({ title, checks }: { title: string; checks: NormalizedCheck[] }) {
  return (
    <div className="rounded-xl border border-[#e2e8f0] bg-white px-3 py-2.5">
      <div className="text-[0.75rem] font-[850] text-[#0f172a]">{title}</div>
      <div className="mt-2 space-y-2">
        {checks.length ? (
          checks.map((check) => (
            <div key={check.id} className="rounded-lg bg-[#f8fafc] px-2.5 py-2">
              <div className="text-[0.72rem] font-extrabold text-[#0f172a]">{check.label}</div>
              <div className="mt-0.5 text-[0.68rem] leading-[1.45] text-[#64748b]">{check.message}</div>
            </div>
          ))
        ) : (
          <div className="rounded-lg bg-[#f8fafc] px-2.5 py-2 text-[0.7rem] text-[#94a3b8]">Aucun élément.</div>
        )}
      </div>
    </div>
  );
}

export function ReadinessBanner({
  title,
  readiness,
  nextAction,
  open,
  busy = false,
  onToggle,
  onPrimaryAction,
  className = "",
}: ReadinessBannerProps) {
  const checks = Array.isArray(readiness?.checks) ? readiness.checks.map(normalizeCheck) : [];
  const grouped = groupChecks(checks);
  const score = Math.max(0, Math.min(100, Number(readiness?.score ?? (checks.length ? 100 : 0))));
  const blockingCount = Number(readiness?.blocking_count ?? grouped.blocking.length);
  const warningCount = Number(readiness?.warning_count ?? grouped.advice.length);
  const tone = toneStyles[nextAction.danger_level] || toneStyles.info;
  const isCalm = nextAction.danger_level === "none" || nextAction.danger_level === "success";
  const progressClassName = progressWidthClass(score);

  return (
    <section
      className={`overflow-hidden rounded-2xl border bg-white shadow-[0_18px_42px_rgba(15,23,42,0.075)] ${tone.border} ${className}`}
    >
      <div className="grid gap-4 px-4 py-3.5 lg:grid-cols-[minmax(260px,0.9fr)_minmax(260px,1fr)_auto] lg:items-center">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${tone.bg} ${tone.icon}`}>
            {isCalm ? <CheckCircle2 className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[0.875rem] font-[850] text-[#0f172a]">{title}</div>
            <p className="mt-1 truncate text-[0.75rem] leading-[1.35] text-[#64748b]">
              {nextAction.reason || readiness?.summary || "Contrôles prêts."}
            </p>
          </div>
        </div>
        <div className="min-w-0 rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2">
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#e2e8f0]">
              <div className={`h-full rounded-full transition-all ${tone.bar} ${progressClassName}`} />
            </div>
            <div className="shrink-0 text-right text-[0.6875rem] font-bold text-[#64748b]">
              <span className={`${tone.text} font-[850]`}>{score}% prêt</span>
              {blockingCount
                ? ` · ${blockingCount} à corriger`
                : warningCount
                  ? ` · ${warningCount} à vérifier`
                  : " · OK"}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onPrimaryAction}
            disabled={busy || nextAction.kind === "none_paid"}
            className={`inline-flex h-9 items-center justify-center gap-2 rounded-full border bg-white px-4 text-[0.75rem] font-[850] shadow-sm transition hover:bg-[#f8fafc] disabled:cursor-not-allowed disabled:opacity-55 ${tone.border} ${tone.text}`}
          >
            {busy ? "Traitement..." : nextAction.label}
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className={`inline-flex h-9 items-center justify-center gap-2 rounded-full border bg-white px-4 text-[0.75rem] font-[850] shadow-sm transition hover:bg-[#f8fafc] ${tone.border} ${tone.text}`}
          >
            {open ? "Masquer les contrôles" : "Voir les contrôles"}
            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
          </button>
        </div>
      </div>
      {open ? (
        <div className="grid gap-3 border-t border-[#e2e8f0] bg-[#fbfdff] px-4 py-3 md:grid-cols-2 xl:grid-cols-4">
          <CheckGroup
            title="Action recommandée"
            checks={[
              {
                id: "next-action",
                label: nextAction.label,
                message: nextAction.reason,
                severity: "info",
                autoFixable: nextAction.autoFixable,
              },
            ]}
          />
          <CheckGroup title="Bloquants" checks={grouped.blocking} />
          <CheckGroup title="Conseils" checks={grouped.advice} />
          <CheckGroup title="À traiter manuellement" checks={grouped.manual} />
        </div>
      ) : null}
    </section>
  );
}
