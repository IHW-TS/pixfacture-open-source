import { useEffect, useState } from "react";
import { apiUrl, fetchWithTimeout, refreshSession as refreshAuthSession } from "./api";
import { defaultAuthCredentials, getAuthHeader } from "./auth";
import { logout } from "./authCookies";
import { setInternalUser } from "./internal";
import { hasHadSession } from "./sessionFlags";
import { shouldRedirectExpiredSession } from "./sessionRoutes";
import { resolveProductCapabilities } from "./productCapabilities";
import { restrictCapabilitiesForTrial } from "./trialMode";
import type { SessionUser, TenantSettings } from "./types";

export type { SessionUser, TenantSettings };

type SessionState = {
  loading: boolean;
  loaded: boolean;
  user: SessionUser | null;
  error: string | null;
};

let sessionState: SessionState = {
  loading: false,
  loaded: false,
  user: null,
  error: null,
};

let sessionLoading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const isDev = process.env.NODE_ENV === "development";
const SESSION_KEEPALIVE_INTERVAL_MS = 45 * 60 * 1000;
const SESSION_KEEPALIVE_STALE_MS = 30 * 60 * 1000;
const SESSION_BOOTSTRAP_TIMEOUT_MS = 5000;
const SESSION_REFRESH_TIMEOUT_MS = 4000;
const SESSION_CHECK_ERROR = "Impossible de vérifier votre session. Réessayez dans un instant.";
const SESSION_REFRESH_ERROR = "Votre session n’a pas pu être actualisée. Reconnectez-vous.";
const MFA_SETUP_REQUIRED_CODE = "mfa_setup_required";
const MFA_SETUP_REQUIRED_NOTICE = "Double authentification requise. Reconnectez-vous pour terminer son activation.";
const LOGIN_NOTICE_KEY = "login_notice";

let lastSessionRefreshAt = 0;
let keepAliveTimer: number | null = null;
let keepAliveSubscribers = 0;

const buildAuthHeaders = () => {
  const headers = { ...getAuthHeader() };
  return Object.keys(headers).length ? headers : undefined;
};

const buildMeRequest = (): RequestInit => ({
  method: "GET",
  headers: buildAuthHeaders(),
  credentials: defaultAuthCredentials(),
  cache: "no-store",
});

const notify = () => {
  listeners.forEach((listener) => listener());
};

const setSessionState = (next: Partial<SessionState>) => {
  sessionState = { ...sessionState, ...next };
  setInternalUser(sessionState.user);
  notify();
};

const logSessionError = (message: string, context?: Record<string, unknown>) => {
  if (!isDev) return;
  if (context) {
    console.warn("[session] " + message, context);
    return;
  }
  console.warn("[session] " + message);
};

const markSessionError = (message: string) => {
  setSessionState({ loading: false, loaded: true, error: message });
};

const markSessionMissing = () => {
  setSessionState({ user: null, loading: false, loaded: true, error: null });
};

const markSessionLogout = () => {
  setSessionState({ user: null, loading: false, loaded: true, error: null });
  const pathname = typeof window !== "undefined" ? window.location.pathname || "" : "";
  void logout({ redirect: shouldRedirectExpiredSession(pathname) });
};

const responseErrorCode = async (response: Response) => {
  const payload = await response.json().catch(() => null);
  return String(payload?.detail?.code || payload?.code || payload?.error?.code || "")
    .trim()
    .toLowerCase();
};

const markMfaSetupRequired = () => {
  setSessionState({ user: null, loading: false, loaded: true, error: MFA_SETUP_REQUIRED_NOTICE });
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(LOGIN_NOTICE_KEY, MFA_SETUP_REQUIRED_NOTICE);
  } catch {
    // The login page still explains the MFA step after credentials are submitted.
  }
  const returnTo = `${window.location.pathname || ""}${window.location.search || ""}${window.location.hash || ""}`;
  void logout({ returnTo });
};

const touchSessionRefresh = () => {
  lastSessionRefreshAt = Date.now();
};

const shouldKeepSessionAlive = () => {
  if (typeof window === "undefined") return false;
  if (!hasHadSession()) return false;
  if (!sessionState.user) return false;
  if (document.visibilityState && document.visibilityState !== "visible") return false;
  return true;
};

const keepSessionAlive = async (force = false) => {
  if (!force && Date.now() - lastSessionRefreshAt < SESSION_KEEPALIVE_STALE_MS) return;
  if (!shouldKeepSessionAlive()) return;
  try {
    const refreshed = await refreshAuthSession();
    if (refreshed) touchSessionRefresh();
  } catch (err) {
    logSessionError("Silent session refresh failed", { stage: "keepalive", error: err });
  }
};

const startSessionKeepAlive = () => {
  if (typeof window === "undefined") return;
  keepAliveSubscribers += 1;
  if (keepAliveTimer) return;
  keepAliveTimer = window.setInterval(() => {
    void keepSessionAlive();
  }, SESSION_KEEPALIVE_INTERVAL_MS);
};

const stopSessionKeepAlive = () => {
  if (typeof window === "undefined") return;
  keepAliveSubscribers = Math.max(0, keepAliveSubscribers - 1);
  if (keepAliveSubscribers || !keepAliveTimer) return;
  window.clearInterval(keepAliveTimer);
  keepAliveTimer = null;
};

const handleVisibilitySessionKeepAlive = () => {
  if (typeof document === "undefined") return;
  if (document.visibilityState !== "visible") return;
  void keepSessionAlive();
};

export function getSessionSnapshot() {
  return sessionState;
}

export async function refreshSession(force = false) {
  if (sessionLoading) return sessionLoading;
  if (!force && sessionState.loaded) return;
  sessionLoading = (async () => {
    if (typeof window === "undefined") return;
    setSessionState({ loading: true, error: null });
    try {
      let res: Response;
      const hadSession = hasHadSession();

      // On hard-reload, the refresh cookie can still be valid while the access cookie
      // has already expired. Refresh first when this browser already had a session so
      // we avoid an unnecessary 401 flash in the shell bootstrap.
      if (!force && hadSession) {
        try {
          const refreshed = await refreshAuthSession(SESSION_REFRESH_TIMEOUT_MS);
          if (refreshed) touchSessionRefresh();
        } catch (err) {
          logSessionError("Pre-refresh session bootstrap failed", { stage: "pre_refresh", error: err });
        }
      }

      res = await fetchWithTimeout(apiUrl("/api/auth/me"), {
        ...buildMeRequest(),
        timeoutMs: SESSION_BOOTSTRAP_TIMEOUT_MS,
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        touchSessionRefresh();
        setSessionState({ user: data || null, loading: false, loaded: true, error: null });
        return;
      }
      if (res.status === 403) {
        const code = await responseErrorCode(res);
        if (code === MFA_SETUP_REQUIRED_CODE) {
          markMfaSetupRequired();
          return;
        }
      }
      if (res.status === 401) {
        const payload = await res.json().catch(() => null);
        const code = payload?.detail?.code || payload?.code || payload?.error?.code || null;
        const normalizedCode = (code || "").toString().toLowerCase();
        const shouldRefresh =
          (normalizedCode === "session_expired" && hadSession) ||
          (force && normalizedCode === "token_missing" && hadSession);
        if (normalizedCode === "cookie_config_issue" || (normalizedCode === "token_missing" && !shouldRefresh)) {
          markSessionMissing();
          return;
        }
        if (!shouldRefresh) {
          markSessionMissing();
          return;
        }
        let refreshed: string | null = null;
        let refreshError: unknown = null;
        try {
          refreshed = await refreshAuthSession(SESSION_REFRESH_TIMEOUT_MS);
        } catch (err) {
          refreshError = err;
        }
        if (refreshError) {
          markSessionError(SESSION_REFRESH_ERROR);
          logSessionError("Session refresh failed", { stage: "refresh", error: refreshError });
          return;
        }
        if (refreshed) {
          const retry = await fetchWithTimeout(apiUrl("/api/auth/me"), {
            ...buildMeRequest(),
            timeoutMs: SESSION_BOOTSTRAP_TIMEOUT_MS,
          });
          if (retry.ok) {
            const data = await retry.json().catch(() => null);
            touchSessionRefresh();
            setSessionState({ user: data || null, loading: false, loaded: true, error: null });
            return;
          }
          if (retry.status === 401) {
            markSessionLogout();
            return;
          }
          if (retry.status === 403) {
            const code = await responseErrorCode(retry);
            if (code === MFA_SETUP_REQUIRED_CODE) {
              markMfaSetupRequired();
              return;
            }
          }
          markSessionError(SESSION_CHECK_ERROR);
          logSessionError("Session check failed after refresh", { stage: "retry", status: retry.status });
          return;
        }
        markSessionLogout();
        return;
      }
      markSessionError(SESSION_CHECK_ERROR);
      logSessionError("Session check failed", { stage: "me", status: res.status });
    } catch (err: unknown) {
      markSessionError(SESSION_CHECK_ERROR);
      logSessionError("Session check failed", { stage: "me", error: err });
    }
  })();
  try {
    await sessionLoading;
  } finally {
    sessionLoading = null;
  }
}

export function clearSession() {
  setSessionState({ user: null, loaded: false, loading: false, error: null });
}

type UseSessionOptions = {
  autoRefresh?: boolean;
};

export function useSession(options: UseSessionOptions = {}) {
  const autoRefresh = options.autoRefresh !== false;
  const [snapshot, setSnapshot] = useState<SessionState>(() => sessionState);

  useEffect(() => {
    const onChange = () => setSnapshot(sessionState);
    const unsubscribe = () => {
      listeners.delete(onChange);
    };
    listeners.add(onChange);
    setSnapshot(sessionState);
    if (autoRefresh) {
      void refreshSession();
      startSessionKeepAlive();
      document.addEventListener("visibilitychange", handleVisibilitySessionKeepAlive);
    }
    return () => {
      unsubscribe();
      if (autoRefresh) {
        document.removeEventListener("visibilitychange", handleVisibilitySessionKeepAlive);
        stopSessionKeepAlive();
      }
    };
  }, [autoRefresh]);

  const subscriptionStatus = snapshot.user?.subscription_status || null;
  const capabilities = restrictCapabilitiesForTrial(
    resolveProductCapabilities(snapshot.user?.capabilities, snapshot.user?.plan),
    subscriptionStatus,
  );

  return {
    loading: autoRefresh ? snapshot.loading || !snapshot.loaded : false,
    user: snapshot.user,
    tenant: snapshot.user?.tenant_id || null,
    role: snapshot.user?.role || null,
    tenantSettings: snapshot.user?.tenant_settings,
    plan: snapshot.user?.plan || null,
    subscriptionStatus,
    trialEnd: snapshot.user?.trial_end || null,
    capabilities,
    error: snapshot.error,
    sessionError: snapshot.error,
    refresh: () => refreshSession(true),
  };
}
