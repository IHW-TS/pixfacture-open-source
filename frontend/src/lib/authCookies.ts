import { apiUrl } from "./apiConfig";
import { clearAuthTokens, defaultAuthCredentials, getAuthHeader, isCookieAuthMode } from "./auth";
import { clearHadSession } from "./sessionFlags";
import { isPublicAppSessionPath } from "./sessionRoutes";

const CSRF_COOKIE = "csrf_token";
const CSRF_CACHE_TTL_MS = 5 * 60 * 1000;
const AUTH_COOKIE_FETCH_TIMEOUT_MS = 8000;
let cachedCsrfToken: { token: string; expiresAt: number } | null = null;
const readCookie = (name: string): string => {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
};

const normalizeReturnTo = (value?: string | null) => {
  const nextValue = (value || "").trim();
  if (!nextValue) return "";
  if (!nextValue.startsWith("/app/")) return "";
  if (nextValue.startsWith("//")) return "";
  if (nextValue.includes("://")) return "";
  return nextValue;
};

const buildLoginUrl = (returnTo?: string | null) => {
  const normalized = normalizeReturnTo(returnTo);
  if (!normalized) return "/app/login";
  return `/app/login?return_to=${encodeURIComponent(normalized)}`;
};

const readCachedCsrfToken = () => {
  if (!cachedCsrfToken) return null;
  if (Date.now() > cachedCsrfToken.expiresAt) {
    cachedCsrfToken = null;
    return null;
  }
  return cachedCsrfToken.token;
};

const writeCachedCsrfToken = (token: string) => {
  cachedCsrfToken = { token, expiresAt: Date.now() + CSRF_CACHE_TTL_MS };
};

export const clearCachedCsrfToken = () => {
  cachedCsrfToken = null;
};

const fetchAuthCookieEndpoint = async (path: string, init: RequestInit = {}) => {
  if (typeof AbortController === "undefined") {
    return await fetch(apiUrl(path), init);
  }
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), AUTH_COOKIE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(apiUrl(path), { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timeout);
  }
};

export function getCsrfCookie() {
  if (!isCookieAuthMode()) return "";
  return readCookie(CSRF_COOKIE);
}
export async function getCsrfToken(options: { force?: boolean } = {}): Promise<string | null> {
  if (!isCookieAuthMode()) return null;
  const force = options.force === true;
  if (!force) {
    const existing = getCsrfCookie();
    if (existing) {
      writeCachedCsrfToken(existing);
      return existing;
    }
    const cached = readCachedCsrfToken();
    if (cached) return cached;
  } else {
    cachedCsrfToken = null;
  }
  try {
    const res = await fetchAuthCookieEndpoint("/api/auth/csrf", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) {
      const fallback = getCsrfCookie();
      if (fallback) writeCachedCsrfToken(fallback);
      return fallback || null;
    }
    const data = await res.json().catch(() => null);
    const token = data?.csrf_token || getCsrfCookie() || null;
    if (token) writeCachedCsrfToken(token);
    return token;
  } catch {
    const fallback = getCsrfCookie();
    if (fallback) writeCachedCsrfToken(fallback);
    return fallback || null;
  }
}

export async function logout(options: { returnTo?: string | null; redirect?: boolean } = {}) {
  if (typeof window === "undefined") return;
  try {
    const csrf = await getCsrfToken();
    const headers = { ...getAuthHeader() };
    if (csrf) headers["X-CSRF-Token"] = csrf;
    await fetchAuthCookieEndpoint("/api/auth/logout", {
      method: "POST",
      credentials: defaultAuthCredentials(),
      headers: Object.keys(headers).length ? headers : undefined,
    });
  } catch {
    // ignore logout failures, we'll still clear local state
  }
  clearAuthTokens();
  clearCachedCsrfToken();
  clearHadSession();
  if (typeof document !== "undefined") {
    document.cookie = `${CSRF_COOKIE}=; Max-Age=0; path=/`;
  }
  const pathname = window.location.pathname || "";
  if (options.redirect !== false && !isPublicAppSessionPath(pathname)) {
    location.href = buildLoginUrl(options.returnTo);
  }
}
