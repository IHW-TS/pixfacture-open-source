"use client";

import { AlertTriangle, CheckCircle2, ExternalLink, FileCheck2 } from "lucide-react";
import { Link } from "@/figma/react-router-compat";

type AccountingReadinessWarning = {
  code?: string;
  label?: string;
  count?: number;
  examples?: string[];
  action?: string;
  href?: string | null;
  cta_label?: string | null;
};

export function AccountingReadinessPanel({
  readiness,
  title = "Dossier comptable",
  compact = false,
}: {
  readiness: any;
  title?: string;
  compact?: boolean;
}) {
  if (!readiness) return null;
  const warnings = Array.isArray(readiness?.warnings)
    ? (readiness.warnings as AccountingReadinessWarning[]).filter(Boolean)
    : [];
  const count = Number(readiness?.warnings_count ?? warnings.length ?? 0);
  const ready = String(readiness?.status || "").toLowerCase() === "ready" && count <= 0;

  if (compact) {
    return (
      <div
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-extrabold ${
          ready ? "border-[#bbf7d0] bg-[#f0fdf4] text-[#047857]" : "border-[#fed7aa] bg-[#fff7ed] text-[#c2410c]"
        }`}
        title={ready ? "Dossier comptable prêt." : `${count || warnings.length || 1} point(s) comptable(s) à vérifier.`}
      >
        {ready ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
        {ready ? "Dossier comptable prêt" : "Compta à vérifier"}
      </div>
    );
  }

  return (
    <section
      className={`rounded-2xl border px-4 py-3 ${
        ready ? "border-[#bbf7d0] bg-[#f0fdf4]" : "border-[#dbe4ef] bg-white"
      }`}
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
            ready ? "bg-[#dcfce7] text-[#059669]" : "bg-[#ffedd5] text-[#ea580c]"
          }`}
        >
          {ready ? <FileCheck2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className={`${ready ? "text-[#047857]" : "text-[#0f172a]"} text-[0.82rem] font-extrabold`}>
            {ready ? `${title} : prêt` : `${title} : ${count || warnings.length} élément(s) à vérifier`}
          </div>
          {!ready && warnings.length ? (
            <div className="mt-2 space-y-2">
              {warnings.slice(0, compact ? 2 : 4).map((warning, index) => {
                const examples = Array.isArray(warning.examples) ? warning.examples.filter(Boolean) : [];
                const ctaLabel = warning.cta_label || "Ouvrir";
                return (
                  <div
                    key={warning.code || `${warning.label}-${index}`}
                    className="rounded-xl border border-[#dbe4ef] bg-[#f8fafc] px-3 py-2"
                  >
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="text-[0.78rem] font-extrabold text-[#0f172a]">
                          {warning.label || "Élément à vérifier"}
                          {Number(warning.count || 0) > 1 ? ` (${warning.count})` : ""}
                        </div>
                        {warning.action ? (
                          <div className="mt-0.5 text-[0.73rem] leading-snug text-[#64748b]">{warning.action}</div>
                        ) : null}
                        {examples.length ? (
                          <div className="mt-1 truncate text-[0.72rem] font-bold text-[#92400e]">
                            Exemple : {examples.join(" · ")}
                          </div>
                        ) : null}
                      </div>
                      {warning.href?.startsWith("#") ? (
                        <a
                          href={warning.href}
                          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[#bfdbfe] bg-white px-2.5 py-1 text-[0.7rem] font-extrabold text-[#1d4ed8]"
                        >
                          {ctaLabel} <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : warning.href ? (
                        <Link
                          to={warning.href}
                          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[#bfdbfe] bg-white px-2.5 py-1 text-[0.7rem] font-extrabold text-[#1d4ed8]"
                        >
                          {ctaLabel} <ExternalLink className="h-3 w-3" />
                        </Link>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
