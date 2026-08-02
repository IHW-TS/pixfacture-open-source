"use client";

import { normalizePlan } from "./plans";
import type { ProductCapabilities } from "./types";

export type ProFeature = "einvoicing" | "purchases" | "payments";

export type ProFeatureGate = {
  enabled: boolean;
  availableByPlan: boolean;
  reactivationRequired: boolean;
  statusLabel: "Plan Pro requis" | "Abonnement Pro à réactiver";
  ctaLabel: "Passer au plan Pro" | "Réactiver l’abonnement Pro";
  ctaHref: "/app/billing";
  reactivationDescription: string | null;
  reactivationNote: string | null;
};

const DEFAULT_CAPABILITIES: ProductCapabilities = {
  reform_preparation: "basic",
  plan: "starter",
  billing_enabled: false,
  einvoicing_available_by_plan: false,
  chorus_available_by_plan: false,
  seqino_available_by_plan: false,
  token_topup_available_by_plan: false,
  purchases_available_by_plan: false,
  payments_available_by_plan: false,
  einvoicing_operational: false,
  chorus_operational: false,
  seqino_operational: false,
  einvoicing_enabled: false,
  chorus_enabled: false,
  seqino_enabled: false,
  token_topup_enabled: false,
  purchases_enabled: false,
  payments_enabled: false,
  upgrade_plan: "pro",
};

export const capabilitiesForPlan = (plan?: string | null): ProductCapabilities => {
  const normalizedPlan = normalizePlan(plan);
  const proLike = normalizedPlan === "pro" || normalizedPlan === "enterprise";
  return {
    ...DEFAULT_CAPABILITIES,
    plan: normalizedPlan,
    einvoicing_available_by_plan: proLike,
    chorus_available_by_plan: proLike,
    seqino_available_by_plan: proLike,
    token_topup_available_by_plan: proLike,
    purchases_available_by_plan: proLike,
    payments_available_by_plan: proLike,
    einvoicing_enabled: proLike,
    chorus_enabled: false,
    seqino_enabled: false,
    token_topup_enabled: proLike,
    purchases_enabled: proLike,
    payments_enabled: proLike,
  };
};

export const resolveProductCapabilities = (
  capabilities?: Partial<ProductCapabilities> | null,
  plan?: string | null,
): ProductCapabilities => {
  const normalizedPlan = normalizePlan(capabilities?.plan || plan);
  if (!capabilities) {
    return {
      ...DEFAULT_CAPABILITIES,
      plan: normalizedPlan,
    };
  }
  return {
    ...DEFAULT_CAPABILITIES,
    ...capabilities,
    plan: normalizedPlan,
  };
};

export const hasProductFeature = (
  capabilities: Partial<ProductCapabilities> | null | undefined,
  feature: keyof ProductCapabilities,
  plan?: string | null,
) => {
  const resolved = resolveProductCapabilities(capabilities, plan);
  return Boolean(resolved[feature]);
};

export const resolveProFeatureGate = (
  capabilities: Partial<ProductCapabilities> | null | undefined,
  feature: ProFeature,
): ProFeatureGate => {
  const enabled = Boolean(capabilities?.[`${feature}_enabled`]);
  const availableByPlan = Boolean(capabilities?.[`${feature}_available_by_plan`]);
  const reactivationRequired = availableByPlan && !enabled;

  return {
    enabled,
    availableByPlan,
    reactivationRequired,
    statusLabel: reactivationRequired ? "Abonnement Pro à réactiver" : "Plan Pro requis",
    ctaLabel: reactivationRequired ? "Réactiver l’abonnement Pro" : "Passer au plan Pro",
    ctaHref: "/app/billing",
    reactivationDescription: reactivationRequired
      ? "Votre espace dispose déjà du plan Pro. Réactivez l’abonnement pour retrouver cette fonctionnalité."
      : null,
    reactivationNote: reactivationRequired
      ? "Aucun changement de plan n’est nécessaire : réactivez simplement l’abonnement Pro."
      : null,
  };
};
