import { Suspense } from "react";
import { RecurringPage } from "@figma-compare/pages/app/AdvancedPages";

function RecurringFallback() {
  return (
    <div className="mx-auto max-w-[1400px] p-5 lg:p-7">
      <div className="rounded-2xl border border-[#e2e8f0] bg-white px-5 py-4 text-[#64748b] shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        Préparation des factures récurrentes…
      </div>
    </div>
  );
}

export default function AppRecurringPage() {
  return (
    <Suspense fallback={<RecurringFallback />}>
      <RecurringPage />
    </Suspense>
  );
}
