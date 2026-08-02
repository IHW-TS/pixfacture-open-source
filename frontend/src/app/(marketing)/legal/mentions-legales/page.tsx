import { MentionsPage } from "@/figma/app/pages/MentionsPage";
import { LEGAL_VARIABLES } from "@/app/(marketing)/legal/variables";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "Mentions légales",
  description: "Mentions légales du service.",
  path: "/legal/mentions-legales",
});

export default function LegalMentionsLegalesPage() {
  return <MentionsPage legalVariables={LEGAL_VARIABLES} />;
}
