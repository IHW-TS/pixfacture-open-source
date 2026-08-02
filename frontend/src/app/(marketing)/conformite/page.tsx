import { createMarketingMetadata } from "@/lib/metadata";
import { ConformiteMarketingPage } from "@/figma/app/pages/MarketingExtraPages";

export const metadata = createMarketingMetadata({
  title: "Conformité 2026-2027",
  description: "Alias vers le centre de confiance.",
  path: "/conformite",
  canonicalPath: "/confiance",
  index: false,
});

export default function ConformitePage() {
  return <ConformiteMarketingPage />;
}
