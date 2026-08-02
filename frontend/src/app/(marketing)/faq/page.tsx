import { FaqPage } from "@/figma/app/pages/FaqPage";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "FAQ",
  description: "Questions fréquentes sur la facturation électronique B2B, les formats et la réforme 2026-2027.",
  path: "/faq",
});

export default function MarketingFaqPage() {
  return <FaqPage />;
}
