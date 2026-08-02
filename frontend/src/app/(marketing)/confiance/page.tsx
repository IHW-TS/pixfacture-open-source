import { ConfiancePage } from "@/figma/app/pages/ConfiancePage";
import { LEGAL_VARIABLES } from "@/app/(marketing)/legal/variables";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "Confiance",
  description: "Centre de confiance : sécurité, conformité et transparence.",
  path: "/confiance",
});

export default function MarketingConfiancePage() {
  return <ConfiancePage legalVariables={LEGAL_VARIABLES} />;
}
