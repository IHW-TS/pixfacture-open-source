import PricingClientPage from "./PricingClientPage";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "Tarifs",
  description: "Plans et options pour la facturation électronique B2B.",
  path: "/pricing",
});

export default function MarketingPricingPage() {
  return <PricingClientPage />;
}
