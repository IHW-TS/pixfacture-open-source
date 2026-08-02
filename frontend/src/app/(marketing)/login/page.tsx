import { redirect } from "next/navigation";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "Connexion",
  description: "Redirection vers l'espace de connexion.",
  path: "/login",
  index: false,
});

export default function LoginPage() {
  redirect("/app/login");
}
