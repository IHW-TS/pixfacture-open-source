"use client";

import AppPageHeader from "@/components/AppPageHeader";
import { getLegalConfig } from "@/lib/legalConfig";
import { PLATFORM_LABEL_LONG } from "@/lib/terminology";

type UpsellConnecteProps = {
  backHref?: string;
};

const TITLE = `Offre Connectée : transmission réglementaire via ${PLATFORM_LABEL_LONG}`;
const SUBTITLE = `Cette fonctionnalité nécessite une ${PLATFORM_LABEL_LONG} contractualisée et, selon le cas, un mandat.`;
const BODY = `Nous ne sommes pas une ${PLATFORM_LABEL_LONG}. La transmission réglementaire (émission/réception, statuts, e‑reporting) s’effectue via une ${PLATFORM_LABEL_LONG}. L’offre Connectée active les connecteurs et le parcours d’onboarding (selon disponibilité), afin de raccorder votre compte à votre ${PLATFORM_LABEL_LONG}.`;
const BULLETS = [
  "✔ Exports (PDF + Factur‑X / EN16931) disponibles selon votre pack",
  `✔ Connexion à une ${PLATFORM_LABEL_LONG} via connecteur (si activé)`,
  "✔ Suivi des statuts et diagnostics (si activé)",
];
const HELP = `Besoin de valider votre cas d’usage ? Contactez-nous : nous vous dirons exactement ce qui est inclus selon votre pack et votre ${PLATFORM_LABEL_LONG}.`;

export default function UpsellConnecte({ backHref = "/app/dashboard" }: UpsellConnecteProps) {
  const { supportEmail } = getLegalConfig();
  const subject = encodeURIComponent("Demande activation offre Connectée");
  const mailto = `mailto:${supportEmail}?subject=${subject}`;

  return (
    <div className="app-main">
      <AppPageHeader title={TITLE} subtitle={SUBTITLE} backHref={backHref} />
      <div className="card grid-simple gap-12">
        <p className="muted m-0">{BODY}</p>
        <ul className="grid-simple gap-6 m-0 pl-18">
          {BULLETS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <div className="muted text-14">{HELP}</div>
        <div className="row gap-8 flex-wrap">
          <a className="btn" href={mailto}>
            Demander l’activation
          </a>
          <a className="btn secondary" href="/app/billing">
            Voir la facturation
          </a>
        </div>
      </div>
    </div>
  );
}
