"use client";
import { ReactNode } from "react";
import { Link } from "@/figma/react-router-compat";

interface Section {
  title: string;
  anchor: string;
}

interface LegalPageShellProps {
  badge?: string;
  title: string;
  subtitle?: string;
  version?: string;
  lastUpdated?: string;
  sections?: Section[];
  children: ReactNode;
}

export function LegalPageShell({
  badge,
  title,
  subtitle,
  version,
  lastUpdated,
  sections,
  children,
}: LegalPageShellProps) {
  const safeSections = sections || [];
  const hasSections = safeSections.length > 0;

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="max-w-[1240px] mx-auto px-6 md:px-8 pb-24">
      {/* Header */}
      <div className="mb-10 py-16" style={{ borderBottom: "1px solid #e2e8f0" }}>
        <div className="mx-auto flex max-w-[820px] flex-col items-center gap-6 text-center">
          {badge && (
            <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] leading-none text-blue-600">
              {badge}
            </span>
          )}
          <h1 className="max-w-[820px] text-[34px] font-bold tracking-tight text-slate-900 md:text-[44px] leading-[1.08]">
            {title}
          </h1>
          {subtitle && <p className="max-w-[760px] text-[17px] leading-relaxed text-slate-500">{subtitle}</p>}
          {(version || lastUpdated) && (
            <div className="mt-1 flex flex-wrap justify-center gap-4 text-[12px] text-slate-600">
              {version && (
                <span className="rounded-xl px-3 py-1.5" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                  Version : <span className="font-medium text-slate-600">{version}</span>
                </span>
              )}
              {lastUpdated && (
                <span className="rounded-xl px-3 py-1.5" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                  Mise à jour : <span className="font-medium text-slate-600">{lastUpdated}</span>
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {hasSections ? (
        <div className="grid lg:grid-cols-[240px_1fr] gap-12">
          <aside className="hidden lg:block">
            <div className="sticky top-28">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600 mb-3">Sommaire</p>
              <nav aria-label="Sommaire de la page" className="flex flex-col gap-1">
                {safeSections.map((s) => (
                  <button
                    key={s.anchor}
                    onClick={() => scrollTo(s.anchor)}
                    className="text-left text-[13px] text-slate-500 hover:text-blue-600 py-1.5 px-3 rounded-lg bg-transparent border-none cursor-pointer transition-colors hover:bg-blue-50"
                  >
                    {s.title}
                  </button>
                ))}
              </nav>
            </div>
          </aside>

          <div className="min-w-0">{children}</div>
        </div>
      ) : (
        <div className="min-w-0">{children}</div>
      )}
    </div>
  );
}

/* ── Reusable sub-components ── */

export function LegalSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="mb-10 scroll-mt-28">
      <h2 className="text-[20px] font-bold text-slate-900 mb-4 pb-2 border-b border-slate-100">{title}</h2>
      <div className="space-y-4 text-[14px] text-slate-600 leading-[1.75]">{children}</div>
    </section>
  );
}

export function LegalSubSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="text-[15px] font-semibold text-slate-800 mb-2">{title}</h3>
      <div className="space-y-2 text-[14px] text-slate-600 leading-[1.75]">{children}</div>
    </div>
  );
}

export function LegalCallout({ type, children }: { type: "info" | "warning" | "important"; children: ReactNode }) {
  const styles = {
    info: "bg-blue-50 border-blue-200 text-blue-800",
    warning: "bg-amber-50 border-amber-200 text-amber-800",
    important: "bg-slate-900 border-slate-900 text-white",
  };
  return <div className={`border rounded-xl px-4 py-3 text-[13px] leading-[1.65] ${styles[type]}`}>{children}</div>;
}

export function LegalTable({ headers, rows }: { headers: string[]; rows: (string | ReactNode)[][] }) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border border-slate-200 sm:block">
        <table className="w-full table-fixed text-[13px]">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {headers.map((h, i) => (
                <th key={i} className="text-left px-4 py-3 text-slate-600 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-slate-100 last:border-0">
                {row.map((cell, j) => (
                  <td key={j} className="px-4 py-3 text-slate-600 align-top break-words">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 sm:hidden">
        {rows.map((row, rowIndex) => (
          <div key={rowIndex} className="rounded-xl border border-slate-200 bg-white p-4">
            {row.map((cell, cellIndex) => (
              <div
                key={cellIndex}
                className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 border-b border-slate-100 py-2.5 first:pt-0 last:border-b-0 last:pb-0"
              >
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-600">
                  {headers[cellIndex]}
                </span>
                <span className="min-w-0 break-words text-[13px] text-slate-700">{cell}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
