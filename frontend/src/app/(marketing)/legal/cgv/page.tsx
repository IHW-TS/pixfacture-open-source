import { TermsPage } from "@/figma/app/pages/TermsPage";
import { LEGAL_VARIABLES } from "@/app/(marketing)/legal/variables";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "CGV",
  description: "Alias vers les conditions générales.",
  path: "/legal/cgv",
  canonicalPath: "/legal/terms",
  index: false,
});

export default function LegalCgvPage() {
  return <TermsPage legalVariables={LEGAL_VARIABLES} />;
}
