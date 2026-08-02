"use client";

import { featureFlags } from "@/lib/featureFlags";
import { partnerNameLabel, resolveMarketingClaimLevel, useComplianceMarketingStatus } from "@/lib/einvoicingMarketing";
import { EXPLANATION } from "@/lib/terminology";

type ComplianceScopeBlockProps = {
  className?: string;
};

const CLAIM_LABELS: Record<string, string> = {
  export_only: "génération/export Factur‑X",
  compatible: "connectable à une plateforme agréée",
  partnered: "intégration active via plateforme agréée partenaire",
};

export default function ComplianceScopeBlock({ className }: ComplianceScopeBlockProps) {
  const runtimeStatus = useComplianceMarketingStatus();
  const level = resolveMarketingClaimLevel(undefined, runtimeStatus, featureFlags);
  const claimLabel = CLAIM_LABELS[level] || CLAIM_LABELS.export_only;
  const partnerName = partnerNameLabel(runtimeStatus, featureFlags);
  const partnerNote = level === "partnered" ? "statut selon liste officielle, mandat requis" : "contrat/mandat requis";
  const partnerLabel = partnerName || "partenaire";

  let claimStatement = "Nous sommes une solution de génération/export Factur‑X.";
  if (level === "compatible") {
    claimStatement = `Nous sommes une solution compatible, connectable à une ${EXPLANATION} choisie par le client.`;
  } else if (level === "partnered") {
    claimStatement = `Nous sommes une solution compatible connectée à une ${EXPLANATION} partenaire (ex: ${partnerLabel}).`;
  }

  const includedItems =
    level === "partnered"
      ? [
          "Génération Factur‑X (PDF + XML).",
          `Transmission via ${EXPLANATION} ${partnerLabel} (${partnerNote}).`,
          "Statuts & traçabilité via le connecteur partenaire.",
        ]
      : level === "compatible"
        ? [
            "Génération Factur‑X (PDF + XML).",
            `Connexion possible à une ${EXPLANATION} pour la transmission réglementaire (${partnerNote}).`,
            "Statuts & traçabilité lorsque le connecteur est activé.",
          ]
        : [
            "Génération/export Factur‑X (PDF + XML).",
            `Préparation au dépôt/transmission via votre ${EXPLANATION}.`,
            "Traçabilité et statuts techniques côté logiciel (statuts officiels gérés par la plateforme).",
          ];

  const notIncludedItems = [
    `Contrat et coûts de la ${EXPLANATION} (abonnement/transactions).`,
    "Immatriculation/agrément de plateforme.",
    "Archivage renforcé configurable (immutabilité Object Lock si activé) / coffre-fort numérique (si requis).",
    "SLA et acheminement réglementaire relevant de la plateforme agréée (PA/PPF) et du contrat applicable.",
  ];

  const rootClassName = className || "";

  return (
    <div className={rootClassName}>
      <div className="card highlight">
        <div className="badge">Périmètre & transparence</div>
        <p className="muted">{claimStatement}</p>
        <p className="muted mt-6">
          <b>Positionnement :</b> {claimLabel}.
        </p>
        <p className="muted mt-6">
          Nous ne sommes pas une {EXPLANATION} immatriculée. La transmission réglementaire passe par une {EXPLANATION}
          contractualisée par le client.
        </p>
      </div>
      <div className="grid mt-10">
        <div className="card">
          <div className="badge">Abonnement Pro</div>
          <ul>
            {includedItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="card">
          <div className="badge">Non couvert</div>
          <ul>
            {notIncludedItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
