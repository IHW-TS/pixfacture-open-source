import { createMarketingMetadata } from "@/lib/metadata";
import { CompatibiliteEinvoicingPage as CompatibilitePage } from "@/figma/app/pages/MarketingExtraPages";

export const metadata = createMarketingMetadata({
  title: "Compatibilité e-invoicing",
  description: "Alias vers la page fonctionnalités.",
  path: "/compatibilite-einvoicing",
  canonicalPath: "/features",
  index: false,
});

export default function CompatibiliteEinvoicingPage() {
  return <CompatibilitePage />;
}
