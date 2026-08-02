import { CookiesPage } from "@/figma/app/pages/CookiesPage";
import { LEGAL_VARIABLES } from "@/app/(marketing)/legal/variables";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "Cookies",
  description: "Politique cookies.",
  path: "/legal/cookies",
});

export default function LegalCookiesPage() {
  return <CookiesPage legalVariables={LEGAL_VARIABLES} />;
}
