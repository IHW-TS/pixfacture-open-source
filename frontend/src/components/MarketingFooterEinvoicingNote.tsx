"use client";

import { featureFlags } from "@/lib/featureFlags";
import { partnerNameLabel, resolveMarketingClaimLevel, useComplianceMarketingStatus } from "@/lib/einvoicingMarketing";
import { EXPLANATION } from "@/lib/terminology";

type MarketingFooterEinvoicingNoteProps = {
  productName: string;
  timelineRange: string;
};

export default function MarketingFooterEinvoicingNote({
  productName,
  timelineRange,
}: MarketingFooterEinvoicingNoteProps) {
  const runtimeStatus = useComplianceMarketingStatus();
  const resolvedClaim = resolveMarketingClaimLevel(undefined, runtimeStatus, featureFlags);
  const partnerName = partnerNameLabel(runtimeStatus, featureFlags);
  const isPartnered = resolvedClaim === "partnered" && Boolean(partnerName);
  const isCompatible = resolvedClaim === "compatible" && !isPartnered;

  const connectionCopy = isPartnered
    ? `transmission via ${EXPLANATION} ${partnerName} (statut selon liste officielle, mandat requis)`
    : isCompatible
      ? `connecteur vers ${EXPLANATION} de votre choix (contrat/mandat requis)`
      : `export Factur-X vers ${EXPLANATION} de votre choix`;

  const transmissionCopy = isPartnered
    ? `L'émission/réception réglementaire est opérée via ${EXPLANATION} ${partnerName} (mandat requis).`
    : `L'émission/réception réglementaire est opérée via une ${EXPLANATION} choisie et contractualisée par le client.`;

  return (
    <>
      <div>
        {productName} est un logiciel de facturation B2B : Factur-X/CII, UBL selon activation, controles de coherence,
        canal public (B2G), et {connectionCopy} pour la reforme {timelineRange || "2026-2027"}.
      </div>
      <div>Nous ne sommes pas une plateforme agréée (PA, ex-PDP). {transmissionCopy}</div>
    </>
  );
}
