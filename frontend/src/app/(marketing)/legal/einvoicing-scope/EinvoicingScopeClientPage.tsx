"use client";

import { OFFICIAL_PDP_INFO_URL, OFFICIAL_PDP_LIST_URL } from "@/lib/officialLinks";
import { featureFlags } from "@/lib/featureFlags";
import { partnerNameLabel, resolveMarketingClaimLevel, useComplianceMarketingStatus } from "@/lib/einvoicingMarketing";
import { EXPLANATION } from "@/lib/terminology";

export default function EinvoicingScope() {
  const runtimeStatus = useComplianceMarketingStatus();
  const resolvedClaim = resolveMarketingClaimLevel(undefined, runtimeStatus, featureFlags);
  const partnerName = partnerNameLabel(runtimeStatus, featureFlags);
  const isPartnered = resolvedClaim === "partnered" && Boolean(partnerName);
  const isCompatible = resolvedClaim === "compatible" && !isPartnered;
  const connectedScopeCopy = isPartnered
    ? `Émission, réception et statuts réglementaires via ${EXPLANATION} ${partnerName}, si plan, mandat et configuration actifs, sous réserve des conditions contractuelles de la PA.`
    : isCompatible
      ? `Émission, réception et statuts réglementaires via ${EXPLANATION} de votre choix, si plan, mandat et configuration actifs, sous réserve des conditions contractuelles de la PA.`
      : `Mode export par défaut. Le mode connecté dépend d'un connecteur actif, d'un mandat valide et d'une configuration complète.`;
  const clientResponsibilities = isPartnered
    ? [
        `Choisir et contractualiser ${EXPLANATION} ${partnerName} (statut selon liste officielle).`,
        "Fournir des informations légales exactes (SIREN/SIRET/TVA).",
        "Signer et maintenir un mandat actif lorsque requis.",
      ]
    : isCompatible
      ? [
          `Choisir et contractualiser une ${EXPLANATION} de votre choix.`,
          "Fournir des informations légales exactes (SIREN/SIRET/TVA).",
          "Signer et maintenir un mandat actif lorsque requis.",
        ]
      : [
          `Choisir et contractualiser une ${EXPLANATION} de votre choix pour la transmission.`,
          "Fournir des informations légales exactes (SIREN/SIRET/TVA).",
          "Le mode connecté nécessite un mandat actif lorsque requis.",
        ];
  const editorResponsibilities = isPartnered
    ? [
        `Fournir le logiciel, les exports et le connecteur vers ${EXPLANATION} ${partnerName} (statut selon liste officielle).`,
        "Assurer le support, les journaux et les diagnostics liés au logiciel.",
      ]
    : isCompatible
      ? [
          `Fournir le logiciel, les exports et le connecteur vers la ${EXPLANATION} choisie (si active).`,
          "Assurer le support, les journaux et les diagnostics liés au logiciel.",
        ]
      : [
          "Fournir le logiciel, les exports Factur‑X selon le plan actif et les contrôles applicatifs.",
          "Assurer le support, les journaux et les diagnostics liés au logiciel.",
        ];

  return (
    <div className="section mk-prelogin-page mk-prelogin-page--legal">
      <h1>Annexe — Périmètre e-facturation</h1>
      <p className="muted">
        Cette annexe contractuelle clarifie le périmètre e-facturation, en distinguant le mode export et le mode
        connecté via plateforme agréée.
      </p>

      <div className="card grid-simple gap-12">
        <div>
          <b>Définitions</b>
          <ul className="muted">
            <li>
              <b>Plateforme agréée (PA)</b> : tiers immatriculé qui assure la transmission réglementaire.
            </li>
            <li>
              <b>Solution compatible</b> : logiciel raccordé à une plateforme agréée via un connecteur (nous ne sommes
              pas une PA).
            </li>
            <li>
              <b>Connecteur</b> : intégration technique reliant le logiciel à une plateforme agréée.
            </li>
            <li>
              <b>Mandat</b> : autorisation contractuelle permettant à l'éditeur d'opérer des actions via la PA.
            </li>
          </ul>
        </div>

        <div>
          <b>Périmètre « Export »</b>
          <p className="muted">
            Génération des factures, PDF et exports structurés selon plan actif et configuration. Le client exporte ses
            données et assure la transmission réglementaire via la plateforme agréée de son choix.
          </p>
        </div>

        <div>
          <b>Périmètre « Connecté »</b>
          <p className="muted">{connectedScopeCopy}</p>
        </div>

        <div>
          <b>Responsabilités du Client</b>
          <ul className="muted">
            {clientResponsibilities.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div>
          <b>Responsabilités de l'Éditeur</b>
          <ul className="muted">
            {editorResponsibilities.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="notice mt-12">
        L'éditeur n'est pas une plateforme agréée (PA, ex-PDP) et ne fournit pas le service de plateforme agréée.
      </div>

      <div className="card mt-16 grid-simple gap-8">
        <b>Références officielles</b>
        <ul className="muted">
          <li>
            <a href={OFFICIAL_PDP_LIST_URL} target="_blank" rel="noopener noreferrer">
              Liste officielle des plateformes agréées (impots.gouv.fr)
            </a>
          </li>
          <li>
            <a href={OFFICIAL_PDP_INFO_URL} target="_blank" rel="noopener noreferrer">
              Facturation électronique et plateformes agréées (impots.gouv.fr)
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
}
