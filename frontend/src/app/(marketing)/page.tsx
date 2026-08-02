import { LandingPage } from "@/figma/app/pages/LandingPage";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "Facturation Électronique B2B",
  description:
    "SaaS de facturation B2B en France : devis, factures, contrôles métier, export Factur-X et e-facturation connectée avec le plan Pro selon activation.",
  path: "/",
});

export default function HomePage() {
  return <LandingPage />;
}
