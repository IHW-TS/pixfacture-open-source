import { BillingPage } from "@figma-compare/pages/app/BillingPage";
import { fetchServerJson } from "@/lib/serverApi";

export default async function AppBillingPage() {
  const [statusResult, plansResult] = await Promise.all([
    fetchServerJson("/api/billing/status"),
    fetchServerJson("/api/billing/plans"),
  ]);

  return (
    <BillingPage
      initialBillingStatus={statusResult.ok ? statusResult.data : null}
      initialPlansPricing={plansResult.ok ? plansResult.data : null}
    />
  );
}
