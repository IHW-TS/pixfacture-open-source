import { TermsPage } from "@/figma/app/pages/TermsPage";
import { LEGAL_VARIABLES } from "@/app/(marketing)/legal/variables";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "CGV / CGU",
  description: "Conditions générales du service.",
  path: "/legal/terms",
});

export default function LegalTermsPage() {
  return <TermsPage legalVariables={LEGAL_VARIABLES} />;
}
