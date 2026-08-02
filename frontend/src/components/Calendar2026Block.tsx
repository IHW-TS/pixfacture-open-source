import {
  complianceTimeline,
  formatIsoDateShortFr,
  sourcesLastUpdatedAvailable,
  sourcesLastUpdatedLabel,
  sourcesUpdateBannerLabel,
  showSourcesUpdateBanner,
} from "@/lib/complianceTimeline";
import { OFFICIAL_CALENDAR_URL } from "@/lib/officialLinks";

const SERVICE_PUBLIC_URL = "https://entreprendre.service-public.fr/";

type Calendar2026BlockProps = {
  className?: string;
  updatedAt?: string;
};

export function Calendar2026Block({ className, updatedAt }: Calendar2026BlockProps) {
  const classes = ["card", className].filter(Boolean).join(" ");
  const updatedOverride = (updatedAt || "").trim();
  const showMissingBanner = showSourcesUpdateBanner && !updatedOverride;
  const lastUpdated = updatedOverride || (sourcesLastUpdatedAvailable ? sourcesLastUpdatedLabel : "");
  const receptionDate = formatIsoDateShortFr(complianceTimeline.einvoicing.reception);
  const emissionGeDate = formatIsoDateShortFr(complianceTimeline.einvoicing.emission_ge_eti);
  const emissionPmeDate = formatIsoDateShortFr(complianceTimeline.einvoicing.emission_pme_micro);
  return (
    <div className={`${classes} grid-simple gap-8`}>
      {showMissingBanner && sourcesUpdateBannerLabel && (
        <div className="alert-inline warning">{sourcesUpdateBannerLabel}</div>
      )}
      <div className="badge">Calendrier France (actuel)</div>
      <ul>
        <li>{receptionDate} : réception obligatoire pour toutes les entreprises.</li>
        <li>{emissionGeDate} : émission pour grandes entreprises & ETI.</li>
        <li>{emissionPmeDate} : émission pour PME et micro-entreprises.</li>
        <li>E‑reporting : même calendrier.</li>
      </ul>
      <p className="muted">
        Nous vous aidons à préparer les données et formats attendus. La réception et la transmission réglementaires
        nécessitent une plateforme agréée sous contrat; l'abonnement au logiciel ne suffit pas à couvrir cette
        obligation.
      </p>
      <div className="muted text-12">
        {lastUpdated && (
          <div>
            <b>Dernière mise à jour :</b> {lastUpdated}
          </div>
        )}
        <div>
          <b>Source officielle :</b>{" "}
          <a href={SERVICE_PUBLIC_URL} target="_blank" rel="noopener noreferrer">
            Service-Public (Entreprendre)
          </a>{" "}
          /{" "}
          <a href={OFFICIAL_CALENDAR_URL} target="_blank" rel="noopener noreferrer">
            impots.gouv.fr
          </a>
        </div>
      </div>
    </div>
  );
}
