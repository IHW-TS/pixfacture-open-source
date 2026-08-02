import { redirect } from "next/navigation";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "Sécurité",
  description: "Alias vers la page sécurité.",
  path: "/legal/security",
  canonicalPath: "/security",
  index: false,
});

export default function LegalSecurityRedirect() {
  redirect("/security");
}
