import type { Metadata } from "next";
import { PasswordResetConfirmPage } from "@/figma/app/pages/auth/PasswordResetPage";

export const metadata: Metadata = {
  title: "Choisir un nouveau mot de passe",
  description: "Définissez un nouveau mot de passe pour votre compte PixFacture.",
  robots: { index: false, follow: false },
};

export default function AppPasswordResetConfirmPage() {
  return <PasswordResetConfirmPage />;
}
