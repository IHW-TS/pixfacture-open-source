import type { Metadata } from "next";
import { PasswordResetPage } from "@/figma/app/pages/auth/PasswordResetPage";

export const metadata: Metadata = {
  title: "Mot de passe oublié",
  description: "Demandez un lien de réinitialisation de votre mot de passe PixFacture.",
  robots: { index: false, follow: false },
};

export default function AppPasswordResetPage() {
  return <PasswordResetPage />;
}
