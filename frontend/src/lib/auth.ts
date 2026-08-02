let memoryAccessToken = "";
let memoryRefreshToken = "";

const parseEnvBool = (raw?: string | null): boolean | null => {
  if (raw === undefined || raw === null) return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return null;
};

const resolveCookieMode = (): boolean => {
  const rawCookie = parseEnvBool(process.env.NEXT_PUBLIC_AUTH_COOKIE_MODE);
  if (rawCookie !== null) return rawCookie;
  const rawBearer = parseEnvBool(process.env.NEXT_PUBLIC_BEARER_MODE);
  if (rawBearer !== null) return !rawBearer;
  return true;
};

const COOKIE_MODE = resolveCookieMode();
const BEARER_TOKEN_PERSIST_MODE = (process.env.NEXT_PUBLIC_BEARER_TOKEN_PERSIST || "").trim().toLowerCase();
const SESSION_ACCESS_KEY = "access_token";
const SESSION_REFRESH_KEY = "refresh_token";
const PROD_LIKE_APP_ENVS = new Set(["prod", "production", "staging"]);

const isProdLikeRuntime = () => {
  const appEnv = (process.env.NEXT_PUBLIC_APP_ENV || process.env.APP_ENV || "").trim().toLowerCase();
  return process.env.NODE_ENV === "production" || PROD_LIKE_APP_ENVS.has(appEnv);
};

const shouldPersistBearerTokens = () => {
  if (COOKIE_MODE || BEARER_TOKEN_PERSIST_MODE !== "session") return false;
  if (isProdLikeRuntime()) {
    throw new Error("NEXT_PUBLIC_BEARER_TOKEN_PERSIST=session est interdit en prod/staging.");
  }
  return true;
};

const restoreSessionTokens = () => {
  if (!shouldPersistBearerTokens()) return;
  if (typeof window === "undefined") return;
  try {
    const storage = window.sessionStorage;
    const access = storage.getItem(SESSION_ACCESS_KEY) || "";
    const refresh = storage.getItem(SESSION_REFRESH_KEY) || "";
    if (access) memoryAccessToken = access;
    if (refresh) memoryRefreshToken = refresh;
  } catch {
    // ignore storage failures
  }
};

const persistSessionTokens = (accessToken?: string | null, refreshToken?: string | null) => {
  if (!shouldPersistBearerTokens()) return;
  if (typeof window === "undefined") return;
  try {
    const storage = window.sessionStorage;
    if (accessToken) storage.setItem(SESSION_ACCESS_KEY, accessToken);
    if (refreshToken) storage.setItem(SESSION_REFRESH_KEY, refreshToken);
  } catch {
    // ignore storage failures
  }
};

const clearSessionTokens = () => {
  if (!shouldPersistBearerTokens()) return;
  if (typeof window === "undefined") return;
  try {
    const storage = window.sessionStorage;
    storage.removeItem(SESSION_ACCESS_KEY);
    storage.removeItem(SESSION_REFRESH_KEY);
  } catch {
    // ignore storage failures
  }
};

restoreSessionTokens();

export const isCookieAuthMode = () => COOKIE_MODE;
export const isBearerAuthMode = () => !COOKIE_MODE;

export const getAccessToken = () => {
  if (COOKIE_MODE) return "";
  return memoryAccessToken;
};

export const getRefreshToken = () => {
  if (COOKIE_MODE) return "";
  return memoryRefreshToken;
};

export const setAuthTokens = (params: {
  accessToken?: string | null;
  refreshToken?: string | null;
  persist?: boolean;
}) => {
  if (COOKIE_MODE) return;
  if (params.accessToken) {
    memoryAccessToken = params.accessToken;
  }
  if (params.refreshToken) {
    memoryRefreshToken = params.refreshToken;
  }
  if (params.persist) {
    persistSessionTokens(params.accessToken, params.refreshToken);
  }
};

export const clearAuthTokens = () => {
  memoryAccessToken = "";
  memoryRefreshToken = "";
  clearSessionTokens();
};

export const getAuthHeader = (): Record<string, string> => {
  if (COOKIE_MODE) return {};
  const token = getAccessToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
};

export const defaultAuthCredentials = (): RequestCredentials | undefined => {
  return "include";
};
