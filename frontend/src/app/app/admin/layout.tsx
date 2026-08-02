"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/useSession";
import { useHydrated } from "@/lib/useHydrated";

export default function AdminLayout({ children }: { children: ReactNode }) {
  const hydrated = useHydrated();
  const router = useRouter();
  const { loading: sessionLoading, user } = useSession({ autoRefresh: false });
  const isPlatformAdmin = user?.is_admin === true;

  if (sessionLoading) {
    return (
      <div className="app-main">
        <div className="card">
          <p className="muted">
            {hydrated ? "Vérification de l’accès en cours." : "Accès administration en cours de vérification."}
          </p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="app-main">
        <div className="card">
          <p className="muted">Connexion requise.</p>
        </div>
      </div>
    );
  }

  if (!isPlatformAdmin) {
    return (
      <div className="app-main">
        <div className="card">
          <p className="muted">Accès réservé à l'administrateur de la plateforme.</p>
          <div className="mt-12">
            <button type="button" className="btn secondary" onClick={() => router.replace("/app/dashboard")}>
              Retour au tableau de bord
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
