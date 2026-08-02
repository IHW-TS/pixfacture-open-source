const parseFlag = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
};

let PLATFORM_LABEL_LONG = "plateforme agréée (PA)";
let EXPLANATION = "plateforme agréée (PA, ex‑PDP)";
try {
  const terminology = require("./terminology");
  PLATFORM_LABEL_LONG = terminology.PLATFORM_LABEL_LONG || PLATFORM_LABEL_LONG;
  EXPLANATION = terminology.EXPLANATION || EXPLANATION;
} catch {
  // Permet aux tests Node (sans loader TS) de fonctionner.
}

const enablePdpIntegration = parseFlag(process.env.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION);
const enablePpfDirectory = parseFlag(process.env.NEXT_PUBLIC_ENABLE_PPF_DIRECTORY);
const enableEinvoicingPages = parseFlag(process.env.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES);
const enableViewTransitionsProto = parseFlag(process.env.NEXT_PUBLIC_ENABLE_VIEW_TRANSITIONS_PROTO, false);
const isProdBuild = process.env.NODE_ENV === "production";
const einvoicingEnabled = enableEinvoicingPages || enablePdpIntegration;
// In prod, MVP mode defaults to ON unless e-invoicing pages or PDP integration are explicitly enabled.
// You can always override with NEXT_PUBLIC_MVP_COMMERCIAL_MODE=true|false.
const defaultMvpCommercialMode = isProdBuild && !einvoicingEnabled;
const isMvpCommercialMode = parseFlag(process.env.NEXT_PUBLIC_MVP_COMMERCIAL_MODE, defaultMvpCommercialMode);

const pdpPartnerLabel = `${PLATFORM_LABEL_LONG} partenaire`;
const pdpPartnerLabelMarketing = `${EXPLANATION} partenaire`;

const pdpIntegrationEnabled = enablePdpIntegration;
const ppfDirectoryEnabled = enablePpfDirectory;

const featureFlags = {
  enablePdpIntegration,
  enablePpfDirectory,
  enableEinvoicingPages,
  enableViewTransitionsProto,
  pdpIntegrationEnabled,
  ppfDirectoryEnabled,
  isMvpCommercialMode,
};

module.exports = {
  enablePdpIntegration,
  enablePpfDirectory,
  enableEinvoicingPages,
  enableViewTransitionsProto,
  isMvpCommercialMode,
  pdpPartnerLabel,
  pdpPartnerLabelMarketing,
  pdpIntegrationEnabled,
  ppfDirectoryEnabled,
  featureFlags,
};
