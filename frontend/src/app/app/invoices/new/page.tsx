import { Suspense } from "react";
import { InvoiceNewPage } from "@figma-compare/pages/app/InvoicesPage";

function InvoiceNewFallback() {
  return (
    <div className="mx-auto max-w-[1400px] p-5 lg:p-7">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-2xl border border-[#e2e8f0] bg-white p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="flex items-center justify-between gap-4 border-b border-[#eef2f7] pb-4">
            <div>
              <div className="text-[0.75rem] font-bold uppercase tracking-[0.08em] text-[#1d4ed8]">Facturation</div>
              <h1 className="mt-2 text-[1.125rem] font-bold text-[#0f172a]">Nouvelle facture</h1>
            </div>
            <div className="h-9 w-28 rounded-xl bg-[#e0ecff]" />
          </div>
          <div className="mt-5 space-y-4">
            <div className="h-11 rounded-xl bg-[#f8fafc]" />
            <div className="h-11 rounded-xl bg-[#f8fafc]" />
            <div className="h-64 rounded-2xl border border-dashed border-[#dbe5ef] bg-[#fcfdff]" />
            <div className="grid grid-cols-3 gap-3">
              <div className="h-16 rounded-xl bg-[#f8fafc]" />
              <div className="h-16 rounded-xl bg-[#f8fafc]" />
              <div className="h-16 rounded-xl bg-[#f8fafc]" />
            </div>
          </div>
        </div>
        <div className="space-y-4">
          <div className="rounded-2xl border border-[#e2e8f0] bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="text-[0.875rem] font-semibold text-[#0f172a]">Résumé</div>
            <div className="mt-4 space-y-3">
              <div className="h-10 rounded-xl bg-[#f8fafc]" />
              <div className="h-10 rounded-xl bg-[#f8fafc]" />
              <div className="h-10 rounded-xl bg-[#f8fafc]" />
            </div>
          </div>
          <p className="px-1 text-[0.8125rem] text-[#64748b]">
            Préparation de la facture et des éléments de facturation.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function AppInvoiceNewPage() {
  return (
    <Suspense fallback={<InvoiceNewFallback />}>
      <InvoiceNewPage />
    </Suspense>
  );
}
