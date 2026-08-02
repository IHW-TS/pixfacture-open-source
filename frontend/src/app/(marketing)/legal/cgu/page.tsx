import { redirect } from "next/navigation";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "CGU",
  description: "Alias vers les conditions générales d'utilisation et de vente.",
  path: "/legal/cgu",
  canonicalPath: "/legal/terms",
  index: false,
});

export default function CguRedirect() {
  redirect("/legal/terms");
}
