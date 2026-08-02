import type { Metadata } from "next";
import { VerifyEmailPage } from "@/figma/app/pages/auth/VerifyEmailPage";

export const metadata: Metadata = {
  title: "Vérifier votre adresse email",
  description: "Vérifiez l'adresse email associée à votre compte PixFacture.",
  robots: { index: false, follow: false },
};

export default function AppVerifyEmailPage() {
  return <VerifyEmailPage />;
}
