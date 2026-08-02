import { ReactNode } from "react";
import { Link } from "react-router";

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

export function LegalPageShell({ badge, title, subtitle, version, lastUpdated, sections, children }: LegalPageShellProps) {
  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="max-w-[1200px] mx-auto px-6 pb-24">
      {/* Header */}
      <div className="py-14 mb-10" style={{ borderBottom: "1px solid #e2e8f0" }}>
        {badge && (
          <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-600 mb-4">{badge}</span>
        )}
        <h1 className="text-[34px] md:text-[44px] font-bold text-slate-900 leading-[1.1] tracking-tight mb-4">
          {title}
        </h1>
        {subtitle && <p className="text-[16px] text-slate-500 max-w-2xl leading-relaxed">{subtitle}</p>}
        {(version || lastUpdated) && (
          <div className="flex flex-wrap gap-4 mt-5 text-[12px] text-slate-400">
            {version && <span className="px-3 py-1.5 rounded-xl" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>Version : <span className="text-slate-600 font-medium">{version}</span></span>}
            {lastUpdated && <span className="px-3 py-1.5 rounded-xl" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>Mise à jour : <span className="text-slate-600 font-medium">{lastUpdated}</span></span>}
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-[240px_1fr] gap-12">
        {/* Sidebar TOC */}
        {sections && sections.length > 0 && (
          <aside className="hidden lg:block">
            <div className="sticky top-28">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 mb-3">Sommaire</p>
              <nav className="flex flex-col gap-1">
                {sections.map((s) => (
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
        )}

        {/* Content */}
        <div className="min-w-0">
          {children}
        </div>
      </div>
    </div>
  );
}

/* ── Reusable sub-components ── */

export function LegalSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="mb-10 scroll-mt-28">
      <h2 className="text-[20px] font-bold text-slate-900 mb-4 pb-2 border-b border-slate-100">{title}</h2>
      <div className="space-y-4 text-[14px] text-slate-600 leading-[1.75]">
        {children}
      </div>
    </section>
  );
}

export function LegalSubSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="text-[15px] font-semibold text-slate-800 mb-2">{title}</h3>
      <div className="space-y-2 text-[14px] text-slate-600 leading-[1.75]">
        {children}
      </div>
    </div>
  );
}

export function LegalCallout({ type, children }: { type: "info" | "warning" | "important"; children: ReactNode }) {
  const styles = {
    info: "bg-blue-50 border-blue-200 text-blue-800",
    warning: "bg-amber-50 border-amber-200 text-amber-800",
    important: "bg-slate-900 border-slate-900 text-white",
  };
  return (
    <div className={`border rounded-xl px-4 py-3 text-[13px] leading-[1.65] ${styles[type]}`}>
      {children}
    </div>
  );
}

export function LegalTable({ headers, rows }: { headers: string[]; rows: (string | ReactNode)[][] }) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border border-slate-200 sm:block">
        <table className="w-full table-fixed text-[13px]">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {headers.map((h, i) => (
                <th key={i} className="text-left px-4 py-3 text-slate-600 font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-slate-100 last:border-0">
                {row.map((cell, j) => (
                  <td key={j} className="px-4 py-3 text-slate-600 align-top break-words">{cell}</td>
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
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
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
