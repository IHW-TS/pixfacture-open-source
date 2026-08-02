import { createMarketingMetadata } from "@/lib/metadata";
import { LEGAL_VARIABLES } from "@/app/(marketing)/legal/variables";
import { SlaPage as SlaDesignPage } from "@/figma/app/pages/MarketingExtraPages";

export const metadata = createMarketingMetadata({
  title: "SLA",
  description: "Alias vers les conditions générales du service.",
  path: "/legal/sla",
  canonicalPath: "/legal/terms",
  index: false,
});

export default function LegalSlaPage() {
  return <SlaDesignPage legalVariables={LEGAL_VARIABLES} />;
}
