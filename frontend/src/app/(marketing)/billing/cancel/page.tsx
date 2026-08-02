import { createMarketingMetadata } from "@/lib/metadata";
import { BillingCancelPage as BillingCancelDesignPage } from "@/figma/app/pages/MarketingExtraPages";

export const metadata = createMarketingMetadata({
  title: "Paiement annulé",
  description: "Retour vers les tarifs.",
  path: "/billing/cancel",
  canonicalPath: "/pricing",
  index: false,
});

export default function BillingCancelPage() {
  return <BillingCancelDesignPage />;
}
