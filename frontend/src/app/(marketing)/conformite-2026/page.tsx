import { createMarketingMetadata } from "@/lib/metadata";
import { Conformite2026Page } from "@/figma/app/pages/MarketingExtraPages";

export const metadata = createMarketingMetadata({
  title: "Conformité 2026-2027",
  description: "Alias historique de la page conformité facturation électronique 2026-2027.",
  path: "/conformite-2026",
  canonicalPath: "/conformite",
  index: false,
});

export default function Conformite2026MarketingPage() {
  return <Conformite2026Page />;
}
