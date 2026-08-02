"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/reportError";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reportError(error, { boundary: "app-root", digest: error.digest || null });
  }, [error]);

  return (
    <div className="container py-10">
      <div className="rounded-2xl border border-[#fecaca] bg-[#fef2f2] p-5 text-[#7f1d1d]">
        <h1>Une erreur est survenue</h1>
        <p className="muted">Cette page est momentanément indisponible. Réessayez dans quelques instants.</p>
        <button className="btn" onClick={() => reset()}>
          Réessayer
        </button>
      </div>
    </div>
  );
}
