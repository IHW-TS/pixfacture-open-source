import { TrustPage } from "@/figma/app/pages/MarketingExtraPages";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "Trust",
  description: "Trust center: sécurité, conformité et transparence.",
  path: "/trust",
});

export default function MarketingTrustPage() {
  return <TrustPage />;
}
