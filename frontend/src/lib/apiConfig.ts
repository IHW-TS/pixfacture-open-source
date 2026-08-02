const DEFAULT_API_PREFIX = "/api";

let cachedOrigin = "";
let cachedPrefix = "";
let cachedBase = "";
let cachedInit = false;
let warned = false;
let logged = false;

const logApiConfigError = (message: string) => {
  if (warned || typeof console === "undefined") return;
  console.error(`[api-config] ${message}`);
  warned = true;
};

const normalizeOrigin = (raw: string): string => {
  let origin = (raw || "").trim();
  if (!origin) return "";
  origin = origin.replace(/\/+$/, "");
  try {
    const url = new URL(origin);
    const path = url.pathname || "/";
    if (path && path !== "/") {
      const hint = path.startsWith("/api")
        ? "NEXT_PUBLIC_API_ORIGIN ne doit pas inclure /api. Utilisez NEXT_PUBLIC_API_PREFIX pour le prefix."
        : "NEXT_PUBLIC_API_ORIGIN doit etre un origin (schema + host), sans chemin.";
      logApiConfigError(`${hint} Valeur fournie: ${origin}`);
    }
    origin = `${url.protocol}//${url.host}`;
  } catch {
    if (/\/api\/?$/.test(origin)) {
      logApiConfigError("NEXT_PUBLIC_API_ORIGIN ne doit pas se terminer par /api.");
      origin = origin.replace(/\/api\/?$/, "");
    }
  }
  return origin.replace(/\/+$/, "");
};

const isLoopbackOrigin = (raw: string): boolean => {
  const value = (raw || "").trim();
  if (!value) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(value);
};

const getRuntimeOriginOverride = () => {
  if (typeof window === "undefined") return "";
  const override = (window as any).__API_ORIGIN_OVERRIDE__;
  return typeof override === "string" ? override.trim() : "";
};

const normalizePrefix = (raw: string): string => {
  let prefix = (raw || DEFAULT_API_PREFIX).trim();
  if (!prefix) prefix = DEFAULT_API_PREFIX;
  if (!prefix.startsWith("/")) prefix = `/${prefix}`;
  prefix = prefix.replace(/\/+$/, "");
  if (!prefix) prefix = DEFAULT_API_PREFIX;
  if (prefix.includes("/api/api")) {
    logApiConfigError(`NEXT_PUBLIC_API_PREFIX invalide (double /api): ${prefix}`);
  }
  return prefix;
};

const initApiConfig = () => {
  if (cachedInit) return;
  const overrideOrigin = getRuntimeOriginOverride();
  const rawOriginEnv = (process.env.NEXT_PUBLIC_API_ORIGIN || "").trim();
  const rawBaseEnv = (process.env.NEXT_PUBLIC_API_BASE_URL || "").trim();
  let rawOrigin = rawOriginEnv || rawBaseEnv;
  if (overrideOrigin) {
    rawOrigin = overrideOrigin;
  } else if (typeof window !== "undefined") {
    const runtimeOrigin = (window.location?.origin || "").trim();
    const builtOrigin = (rawOriginEnv || rawBaseEnv || "").trim();
    // Safety net: if the frontend bundle was built with localhost but runs on a real domain,
    // prefer current runtime origin to keep API calls same-origin.
    if (runtimeOrigin && isLoopbackOrigin(builtOrigin) && !isLoopbackOrigin(runtimeOrigin)) {
      rawOrigin = runtimeOrigin;
    }
  }
  if (!rawOriginEnv && rawBaseEnv) {
    rawOrigin = rawBaseEnv.replace(/\/api\/?$/, "");
  }
  const rawPrefix = (process.env.NEXT_PUBLIC_API_PREFIX || DEFAULT_API_PREFIX).trim();
  cachedOrigin = normalizeOrigin(rawOrigin);
  cachedPrefix = normalizePrefix(rawPrefix);
  cachedBase = cachedOrigin ? `${cachedOrigin}${cachedPrefix}` : cachedPrefix;
  if (/\/api\/api(\/|$)/.test(cachedBase)) {
    logApiConfigError(
      `URL API invalide (base resolue = ${cachedBase}). Verifiez NEXT_PUBLIC_API_ORIGIN et NEXT_PUBLIC_API_PREFIX.`,
    );
  }
  if (!logged && typeof console !== "undefined" && process.env.NODE_ENV !== "production") {
    console.info(`[api-config] base resolue = ${cachedBase}`);
    logged = true;
  }
  cachedInit = true;
};

export const apiOrigin = () => {
  initApiConfig();
  return cachedOrigin;
};

export const apiPrefix = () => {
  initApiConfig();
  return cachedPrefix;
};

export const apiBase = () => {
  initApiConfig();
  return cachedBase;
};

export const apiUrl = (path: string) => {
  initApiConfig();
  let normalized = (path || "").trim();
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (normalized === cachedPrefix) {
    normalized = "/";
  } else if (normalized.startsWith(`${cachedPrefix}/`)) {
    normalized = normalized.slice(cachedPrefix.length);
  }
  const url = `${cachedBase}${normalized}`;
  if (/\/api\/api(\/|$)/.test(url)) {
    logApiConfigError(`URL API invalide (double /api) : ${url}`);
  }
  return url;
};
