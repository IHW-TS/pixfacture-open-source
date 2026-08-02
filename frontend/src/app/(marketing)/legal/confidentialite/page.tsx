import { PrivacyPage } from "@/figma/app/pages/PrivacyPage";
import { LEGAL_VARIABLES } from "@/app/(marketing)/legal/variables";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "Confidentialité",
  description: "Politique de confidentialité.",
  path: "/legal/confidentialite",
});

export default function LegalConfidentialitePage() {
  return <PrivacyPage legalVariables={LEGAL_VARIABLES} />;
}
