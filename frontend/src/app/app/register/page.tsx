import type { Metadata } from "next";
import { Suspense } from "react";
import { RegisterPage } from "@/figma/app/pages/auth/RegisterPage";

export const metadata: Metadata = {
  title: "Créer un compte",
  description: "Créez votre espace professionnel PixFacture.",
  robots: { index: false, follow: false },
};

function RegisterFallback() {
  return (
    <div className="min-h-screen bg-[#f8fafc]">
      <div className="mx-auto max-w-md px-6 py-10">
        <div className="rounded-2xl border border-[#e2e8f0] bg-white px-5 py-4 text-[#64748b] shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          Préparation du formulaire d'inscription…
        </div>
      </div>
    </div>
  );
}

export default function AppRegisterPage() {
  return (
    <Suspense fallback={<RegisterFallback />}>
      <RegisterPage />
    </Suspense>
  );
}
