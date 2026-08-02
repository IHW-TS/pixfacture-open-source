import { createMarketingMetadata } from "@/lib/metadata";
import { PlateformesPage as PlateformesMarketingPage } from "@/figma/app/pages/MarketingExtraPages";

export const metadata = createMarketingMetadata({
  title: "Plateformes",
  description: "Alias vers la page fonctionnalités.",
  path: "/plateformes",
  canonicalPath: "/features",
  index: false,
});

export default function PlateformesPage() {
  return <PlateformesMarketingPage />;
}
