import { DpaPage } from "@/figma/app/pages/DpaPage";
import { LEGAL_VARIABLES } from "@/app/(marketing)/legal/variables";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "Accord de sous-traitance RGPD (DPA)",
  description: "Accord de sous-traitance RGPD et traitement des données (DPA).",
  path: "/legal/dpa",
});

export default function LegalDpaPage() {
  return <DpaPage legalVariables={LEGAL_VARIABLES} />;
}
