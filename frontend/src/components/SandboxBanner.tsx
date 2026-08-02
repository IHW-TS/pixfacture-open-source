"use client";

export default function SandboxBanner() {
  const demoMode = (process.env.NEXT_PUBLIC_DEMO_MODE || "").toLowerCase() === "true";
  if (!demoMode) return null;
  return (
    <div className="alert-inline warning mb-12">
      <strong>Mode test</strong> — données fictives et fonctions de démonstration activées.{" "}
      <a className="underline" href="/app/settings/sandbox">
        Ouvrir l’espace de test
      </a>
    </div>
  );
}
