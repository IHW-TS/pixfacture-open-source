"use client";

import { useEffect } from "react";
import { logout as browserLogout } from "@/lib/authCookies";
import { clearSession } from "@/lib/useSession";

export default function LogoutPage() {
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!cancelled) {
        clearSession();
      }
      await browserLogout();
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="figma-root min-h-screen bg-[#f0f4fa] grid place-items-center px-4">
      <div
        className="w-full max-w-sm rounded-xl border border-[#dbe4f0] bg-white px-6 py-5 text-center shadow-sm"
        role="status"
        aria-live="polite"
      >
        <h1 className="text-lg font-semibold text-[#0f172a]">Déconnexion en cours…</h1>
        <p className="mt-2 text-sm leading-6 text-[#64748b]">
          Votre session est en cours de fermeture. Vous allez être redirigé vers la page de connexion.
        </p>
        <a
          href="/app/login"
          className="mt-4 inline-flex rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-semibold text-[#334155] hover:bg-[#f8fafc]"
        >
          Revenir à la connexion
        </a>
      </div>
    </div>
  );
}
