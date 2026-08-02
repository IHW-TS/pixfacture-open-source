import { createMarketingMetadata } from "@/lib/metadata";
import { EinvoicingScopePage as EinvoicingScopeDesignPage } from "@/figma/app/pages/MarketingExtraPages";

export const metadata = createMarketingMetadata({
  title: "Annexe e-facturation",
  description: "Alias vers la page fonctionnalités.",
  path: "/legal/einvoicing-scope",
  canonicalPath: "/features",
  index: false,
});

export default function EinvoicingScopePage() {
  return <EinvoicingScopeDesignPage />;
}
