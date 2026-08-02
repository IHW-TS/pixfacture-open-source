import { FeaturesPage } from "@/figma/app/pages/FeaturesPage";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "Fonctionnalités",
  description:
    "Détail des fonctionnalités produit : devis, factures, contrôles, sécurité, export Factur-X et connecteurs Pro selon configuration.",
  path: "/features",
});

export default function MarketingFeaturesPage() {
  return <FeaturesPage />;
}
