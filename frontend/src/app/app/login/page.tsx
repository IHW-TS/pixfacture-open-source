import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginPage } from "@/figma/app/pages/auth/LoginPage";

export const metadata: Metadata = {
  title: "Connexion",
  description: "Connectez-vous à votre espace PixFacture.",
  robots: { index: false, follow: false },
};

function LoginFallback() {
  return (
    <div className="min-h-screen bg-[#f8fafc]">
      <div className="mx-auto max-w-md px-6 py-10">
        <div className="rounded-2xl border border-[#e2e8f0] bg-white px-5 py-4 text-[#64748b] shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          Préparation de la connexion…
        </div>
      </div>
    </div>
  );
}

export default function AppLoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginPage />
    </Suspense>
  );
}
