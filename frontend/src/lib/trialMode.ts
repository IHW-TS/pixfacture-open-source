import type { ProductCapabilities } from "./types";

const normalizeTrialStatus = (status?: string | null) =>
  String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

export const TRIAL_LIVE_ACTION_MESSAGE =
  "L’essai Pro est limité aux brouillons et prévisualisations. Choisissez un abonnement pour émettre, envoyer ou transmettre.";

export function isTrialSubscription(status?: string | null) {
  const normalized = normalizeTrialStatus(status);
  return normalized === "trial" || normalized === "trialing";
}

export function restrictCapabilitiesForTrial(
  capabilities: ProductCapabilities,
  subscriptionStatus?: string | null,
): ProductCapabilities {
  if (!isTrialSubscription(subscriptionStatus)) return capabilities;
  return {
    ...capabilities,
    einvoicing_operational: false,
    chorus_operational: false,
    seqino_operational: false,
    // L'essai conserve la visibilité du périmètre Pro pour permettre sa
    // découverte. Les opérations fournisseur et les achats de jetons restent
    // néanmoins coupés jusqu'à l'activation d'un abonnement payant.
    einvoicing_enabled: Boolean(capabilities.einvoicing_available_by_plan),
    chorus_enabled: false,
    seqino_enabled: false,
    token_topup_enabled: false,
  };
}
