import { useEffect, useState } from "react";
import { fetchComplianceClaims, parseComplianceClaimLevel, resolveComplianceClaimLevel } from "@/lib/complianceClaims";
import { pdpIntegrationEnabled } from "@/lib/featureFlags";

export type ComplianceClaimLevel = "export_only" | "compatible" | "partnered";

export type ComplianceRuntimeStatus = {
  allowed_claims?: ComplianceClaimLevel[];
  pdp_integration_enabled?: boolean;
  seqino_enabled?: boolean;
  chorus_enabled?: boolean;
  platform_agreed?: boolean;
  partnered?: boolean;
  mandate_required?: boolean;
  fr_2027_status?: "partial" | "complete";
};

export type FeatureFlags = {
  pdpIntegrationEnabled?: boolean;
};

const DEFAULT_PARTNER_NAME = "plateforme partenaire";
const PRODUCTION_FALLBACK: ComplianceRuntimeStatus = {
  allowed_claims: ["export_only"],
  pdp_integration_enabled: false,
};
const LEVEL_RANK: Record<ComplianceClaimLevel, number> = {
  export_only: 0,
  compatible: 1,
  partnered: 2,
};

type ClaimCoherence = {
  incoherent: boolean;
  safeLevel: ComplianceClaimLevel;
  reason?: string;
  message?: string;
};

const resolveAllowedMaxLevel = (runtimeStatus?: ComplianceRuntimeStatus | null): ComplianceClaimLevel => {
  const allowedRaw = Array.isArray(runtimeStatus?.allowed_claims) ? runtimeStatus.allowed_claims : [];
  if (!allowedRaw.length) return "export_only";
  return allowedRaw.reduce((max, item) => (LEVEL_RANK[item] > LEVEL_RANK[max] ? item : max), "export_only");
};

const resolveRuntimePartnered = (runtimeStatus?: ComplianceRuntimeStatus | null) => {
  if (typeof runtimeStatus?.partnered === "boolean") return runtimeStatus.partnered;
  return Array.isArray(runtimeStatus?.allowed_claims) ? runtimeStatus.allowed_claims.includes("partnered") : false;
};

const resolveRuntimePlatformAgreed = (runtimeStatus?: ComplianceRuntimeStatus | null) => {
  if (typeof runtimeStatus?.platform_agreed === "boolean") return runtimeStatus.platform_agreed;
  return Boolean(runtimeStatus?.seqino_enabled || runtimeStatus?.chorus_enabled);
};

const resolveRequestedLevel = (level?: ComplianceClaimLevel | null) => {
  const rawEnv = (process.env.NEXT_PUBLIC_COMPLIANCE_CLAIM_LEVEL || "").trim();
  const hasExplicitLevel = Boolean(level && String(level).trim());
  const hasEnvLevel = Boolean(rawEnv);
  if (hasExplicitLevel || hasEnvLevel) {
    return parseComplianceClaimLevel(hasExplicitLevel ? level : rawEnv) as ComplianceClaimLevel;
  }
  return null;
};

export const getMarketingClaimCoherence = (
  level?: ComplianceClaimLevel | null,
  runtimeStatus?: ComplianceRuntimeStatus | null,
  featureFlags?: FeatureFlags,
): ClaimCoherence => {
  const requested = resolveRequestedLevel(level);
  if (requested !== "partnered") {
    return { incoherent: false, safeLevel: resolveAllowedMaxLevel(runtimeStatus) };
  }
  if (!runtimeStatus) {
    return { incoherent: false, safeLevel: resolveAllowedMaxLevel(runtimeStatus) };
  }
  const runtimePartnered = resolveRuntimePartnered(runtimeStatus);
  const runtimePlatformAgreed = resolveRuntimePlatformAgreed(runtimeStatus);
  if (runtimePartnered && runtimePlatformAgreed) {
    return { incoherent: false, safeLevel: resolveAllowedMaxLevel(runtimeStatus) };
  }
  const safeLevel = resolveAllowedMaxLevel(runtimeStatus);
  let reason = "partnered_disabled";
  if (!runtimePlatformAgreed) reason = "platform_agreed_missing";
  if (runtimeStatus?.pdp_integration_enabled === false) reason = "pdp_integration_disabled";
  const message =
    "Configuration incohérente : le claim marketing annonce un partenariat, mais /api/compliance/claims ne le confirme pas.";
  return { incoherent: true, safeLevel, reason, message };
};

const resolvePdpIntegrationEnabled = (runtimeStatus?: ComplianceRuntimeStatus | null, featureFlags?: FeatureFlags) => {
  if (typeof runtimeStatus?.pdp_integration_enabled === "boolean") {
    return runtimeStatus.pdp_integration_enabled;
  }
  if (typeof featureFlags?.pdpIntegrationEnabled === "boolean") {
    return featureFlags.pdpIntegrationEnabled;
  }
  return pdpIntegrationEnabled;
};

export const resolveMarketingClaimLevel = (
  level?: ComplianceClaimLevel | null,
  runtimeStatus?: ComplianceRuntimeStatus | null,
  featureFlags?: FeatureFlags,
): ComplianceClaimLevel => {
  const rawEnv = (process.env.NEXT_PUBLIC_COMPLIANCE_CLAIM_LEVEL || "").trim();
  const hasExplicitLevel = Boolean(level && String(level).trim());
  const hasEnvLevel = Boolean(rawEnv);
  let resolved: ComplianceClaimLevel | null = null;

  if (hasExplicitLevel || hasEnvLevel) {
    const baseLevel = parseComplianceClaimLevel(hasExplicitLevel ? level : rawEnv);
    resolved = resolveComplianceClaimLevel(baseLevel, runtimeStatus || undefined, {
      warn: true,
    }) as ComplianceClaimLevel;
  } else if (Array.isArray(runtimeStatus?.allowed_claims) && runtimeStatus.allowed_claims.length) {
    const allowed = runtimeStatus.allowed_claims as ComplianceClaimLevel[];
    resolved = allowed.reduce((max, item) => (LEVEL_RANK[item] > LEVEL_RANK[max] ? item : max), "export_only");
  }

  let finalLevel = resolved || "export_only";
  const coherence = getMarketingClaimCoherence(level, runtimeStatus, featureFlags);
  if (coherence.incoherent) {
    finalLevel = coherence.safeLevel;
  }
  if (!resolvePdpIntegrationEnabled(runtimeStatus, featureFlags)) {
    return "export_only";
  }
  return finalLevel;
};

export const shouldShowPartneredMessaging = (
  runtimeStatus?: ComplianceRuntimeStatus | null,
  featureFlags?: FeatureFlags,
  level?: ComplianceClaimLevel | null,
) => {
  const resolved = resolveMarketingClaimLevel(level, runtimeStatus, featureFlags);
  return resolvePdpIntegrationEnabled(runtimeStatus, featureFlags) && resolved === "partnered";
};

export const partnerNameLabel = (
  runtimeStatus?: ComplianceRuntimeStatus | null,
  featureFlags?: FeatureFlags,
  level?: ComplianceClaimLevel | null,
) => {
  return shouldShowPartneredMessaging(runtimeStatus, featureFlags, level) ? DEFAULT_PARTNER_NAME : "";
};

export const useComplianceMarketingStatus = (status?: ComplianceRuntimeStatus | null) => {
  const initial = status || (process.env.NODE_ENV === "production" ? PRODUCTION_FALLBACK : null);
  const [runtimeStatus, setRuntimeStatus] = useState<ComplianceRuntimeStatus | null>(initial);

  useEffect(() => {
    if (status) return;
    let active = true;
    fetchComplianceClaims().then((data) => {
      if (!active || !data) return;
      setRuntimeStatus(data);
    });
    return () => {
      active = false;
    };
  }, [status]);

  return runtimeStatus;
};
