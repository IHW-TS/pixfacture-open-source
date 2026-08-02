const { PLATFORM_LABEL_LONG } = require("./terminology");

const CLAIM_LEVELS = ["export_only", "compatible", "partnered"];
const LEVEL_RANK = {
  export_only: 0,
  compatible: 1,
  partnered: 2,
};
const DEFAULT_LEVEL = "export_only";
const DEFAULT_PREFIX = "/api";

const normalizeLevel = (raw) => {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (CLAIM_LEVELS.includes(value)) return value;
  return DEFAULT_LEVEL;
};

const parseComplianceClaimLevel = (raw) => normalizeLevel(raw);

const _normalizePrefix = (raw) => {
  let prefix = (raw || DEFAULT_PREFIX).trim();
  if (!prefix) prefix = DEFAULT_PREFIX;
  if (!prefix.startsWith("/")) prefix = `/${prefix}`;
  prefix = prefix.replace(/\/+$/, "");
  return prefix || DEFAULT_PREFIX;
};

const _normalizeOrigin = (raw) => {
  let origin = (raw || "").trim();
  if (!origin) return "";
  origin = origin.replace(/\/+$/, "");
  if (origin.endsWith("/api")) {
    origin = origin.replace(/\/api$/, "");
  }
  return origin.replace(/\/+$/, "");
};

const _getRuntimeOriginOverride = () => {
  if (typeof window === "undefined") return "";
  const override = window.__API_ORIGIN_OVERRIDE__;
  return typeof override === "string" ? override.trim() : "";
};

const _apiBase = () => {
  const override = _getRuntimeOriginOverride();
  const origin = _normalizeOrigin(
    override || process.env.NEXT_PUBLIC_API_ORIGIN || process.env.NEXT_PUBLIC_API_BASE_URL || "",
  );
  const prefix = _normalizePrefix(process.env.NEXT_PUBLIC_API_PREFIX || DEFAULT_PREFIX);
  return origin ? `${origin}${prefix}` : prefix;
};

const _joinUrl = (base, path) => {
  const baseClean = (base || "").replace(/\/+$/, "");
  const pathClean = path.startsWith("/") ? path : `/${path}`;
  if (!baseClean) return pathClean;
  return `${baseClean}${pathClean}`;
};

const fetchComplianceClaims = async () => {
  const url = _joinUrl(_apiBase(), "/compliance/claims");
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 2500) : null;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller ? controller.signal : undefined,
      credentials: "omit",
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const resolveComplianceClaimLevel = (level, runtimeStatus, options = {}) => {
  const normalized = normalizeLevel(level);
  const allowedRaw = Array.isArray(runtimeStatus?.allowed_claims)
    ? runtimeStatus.allowed_claims.map(normalizeLevel)
    : [];
  const allowed = allowedRaw.filter((item) => CLAIM_LEVELS.includes(item));
  if (!allowed.length) return normalized;
  let maxAllowed = DEFAULT_LEVEL;
  for (const item of allowed) {
    if (LEVEL_RANK[item] > LEVEL_RANK[maxAllowed]) {
      maxAllowed = item;
    }
  }
  let resolved = normalized;
  if (LEVEL_RANK[normalized] > LEVEL_RANK[maxAllowed]) {
    resolved = maxAllowed;
    if (options.warn && typeof console !== "undefined" && process.env.NODE_ENV !== "production") {
      console.warn(
        `[compliance] NEXT_PUBLIC_COMPLIANCE_CLAIM_LEVEL=${normalized} downgraded to ${maxAllowed} by /api/compliance/claims.`,
      );
    }
  }
  return resolved;
};

const getComplianceLabel = (level, runtimeStatus, options = {}) => {
  const resolved = resolveComplianceClaimLevel(level, runtimeStatus, { warn: options.warn });
  if (resolved === "export_only") return "logiciel de facturation B2B";
  return "solution compatible";
};

const getComplianceCopy = (level, runtimeStatus) => {
  const resolved = resolveComplianceClaimLevel(level, runtimeStatus, { warn: true });
  const disclaimers = [
    `Nous ne sommes pas une ${PLATFORM_LABEL_LONG}.`,
    `Les transmissions réglementaires s’effectuent via une ${PLATFORM_LABEL_LONG} sous contrat/mandat.`,
  ];
  let headline = "Facturation B2B pour l’export réglementaire";
  let subline = `Factur‑X / CII selon configuration, contrôles et exports — transmission via votre ${PLATFORM_LABEL_LONG}.`;
  if (resolved === "compatible") {
    headline = "Facturation B2B — solution compatible";
    subline = `Connectable à une ${PLATFORM_LABEL_LONG} via connecteur, selon contrat/mandat.`;
  } else if (resolved === "partnered") {
    headline = "Facturation B2B — solution compatible (via partenaire)";
    subline = `Connecteur partenaire vers une ${PLATFORM_LABEL_LONG}, activation selon contrat/mandat.`;
  } else {
    headline = "Facturation B2B pour l’export réglementaire";
    subline = `Factur‑X / CII selon configuration, contrôles et exports — transmission via votre ${PLATFORM_LABEL_LONG}.`;
  }
  return { level: resolved, headline, subline, disclaimers };
};

module.exports = {
  CLAIM_LEVELS,
  parseComplianceClaimLevel,
  resolveComplianceClaimLevel,
  getComplianceLabel,
  getComplianceCopy,
  fetchComplianceClaims,
};
