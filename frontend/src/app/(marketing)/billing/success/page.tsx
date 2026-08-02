import { createMarketingMetadata } from "@/lib/metadata";
import { BillingSuccessPage as BillingSuccessDesignPage } from "@/figma/app/pages/MarketingExtraPages";

export const metadata = createMarketingMetadata({
  title: "Activation en cours",
  description: "Retour sécurisé après le paiement de l’abonnement.",
  path: "/billing/success",
  index: false,
});

export default function BillingSuccessPage() {
  return <BillingSuccessDesignPage />;
}
