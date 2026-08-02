import { SecurityPage } from "@/figma/app/pages/SecurityPage";
import { LEGAL_VARIABLES } from "@/app/(marketing)/legal/variables";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "Sécurité",
  description: "Sécurité applicative, hébergement et conformité des données.",
  path: "/security",
});

export default function MarketingSecurityPage() {
  return <SecurityPage legalVariables={LEGAL_VARIABLES} />;
}
