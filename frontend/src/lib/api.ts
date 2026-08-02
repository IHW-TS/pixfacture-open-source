import { clearCachedCsrfToken, getCsrfToken, logout } from "./authCookies";
import { defaultAuthCredentials, getAuthHeader, getRefreshToken, isCookieAuthMode, setAuthTokens } from "./auth";
import { apiBase, apiOrigin as apiOriginFn, apiUrl } from "./apiConfig";
import { shouldHideDevPages } from "./devPages";
import { getInternalUser } from "./internal";
import { sanitizeStructuredInvoiceErrorDetail } from "./invoiceComplianceUi";
import type { ApiError } from "./types";

export { apiBase, apiUrl };

// Server-side helpers (Next Route Handlers): expose a simple string origin.
// Some route handlers proxy to the backend and need a concrete origin string.
export const apiOrigin = apiOriginFn();

let apiUrlLogged = false;
let apiBaseWarned = false;
let apiBaseChecked = false;
const isDevEnv = process.env.NODE_ENV !== "production";

const normalizeApiBase = (base: string) => {
  let normalized = (base || "").trim();
  if (!normalized) return "";
  normalized = normalized.replace(/\/+$/, "");
  if (normalized.endsWith("/api")) {
    if (!apiBaseWarned && typeof console !== "undefined" && process.env.NODE_ENV !== "production") {
      console.warn("[api] NEXT_PUBLIC_API_BASE_URL ne doit pas se terminer par /api (les appels ajoutent deja /api).");
      apiBaseWarned = true;
    }
    normalized = normalized.replace(/\/api$/, "");
  }
  return normalized;
};

const collapseSlashes = (value: string) => {
  if (!value) return value;
  const cut = value.search(/[?#]/);
  const head = cut === -1 ? value : value.slice(0, cut);
  const tail = cut === -1 ? "" : value.slice(cut);
  const schemeMatch = head.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//);
  if (!schemeMatch) {
    return head.replace(/\/{2,}/g, "/") + tail;
  }
  const scheme = schemeMatch[0];
  const rest = head.slice(scheme.length).replace(/\/{2,}/g, "/");
  return `${scheme}${rest}${tail}`;
};

const normalizeApiUrl = (url: string) => {
  let normalized = (url || "").trim();
  if (!normalized) return normalized;
  normalized = normalized.replace(/\/api\/api(\/|$)/g, "/api$1");
  normalized = collapseSlashes(normalized);
  return normalized;
};

const checkApiBaseConfig = () => {
  if (apiBaseChecked) return;
  const rawOrigin = (process.env.NEXT_PUBLIC_API_ORIGIN || "").trim();
  const rawBase = (process.env.NEXT_PUBLIC_API_BASE_URL || "").trim();
  const appEnv = (process.env.APP_ENV || "").trim().toLowerCase();
  const prodLike = !!appEnv && !["dev", "test", "local"].includes(appEnv);
  if (typeof console !== "undefined" && process.env.NODE_ENV !== "production") {
    if (rawOrigin && rawBase) {
      console.info("[api] NEXT_PUBLIC_API_ORIGIN a priorite sur NEXT_PUBLIC_API_BASE_URL.");
    }
    if (prodLike && rawBase && /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(rawBase)) {
      console.warn(
        "[api] NEXT_PUBLIC_API_BASE_URL pointe vers localhost en prod/staging; laissez vide ou utilisez le domaine public.",
      );
    }
  }
  normalizeApiBase(rawBase);
  apiBaseChecked = true;
};

const buildApiUrl = (path: string) => {
  checkApiBaseConfig();
  const url = normalizeApiUrl(apiUrl(path));
  if (!apiUrlLogged && typeof console !== "undefined" && process.env.NODE_ENV !== "production") {
    console.info(`[api] url=${url}`);
    apiUrlLogged = true;
  }
  return url;
};

const parseMaybeJson = (value: any) => {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const DEFAULT_API_ERROR_MESSAGE =
  "Cette action n'a pas pu être réalisée pour le moment. Réessayez dans quelques instants.";
const DEFAULT_API_UNAVAILABLE_MESSAGE = "Service momentanément indisponible. Réessayez dans quelques instants.";
const DEFAULT_SESSION_MESSAGE = "Votre session a expiré. Reconnectez-vous pour continuer.";
const DEFAULT_NOT_FOUND_MESSAGE = "Élément introuvable.";

const TECHNICAL_ERROR_PATTERN =
  /\b(api|backend|endpoint|upstream|payload|tenant|csrf|cors|cookie_config|samesite|stack|traceback|exception|typeerror|keyerror|valueerror|attributeerror|runtimeerror|operationalerror|timeouterror|internal server error|bad gateway|service unavailable|gateway timeout|validation interne|sql|database|integrityerror|pydantic|validationerror|undefined|null|nan|localhost|webhook|provider|request_id|smtp|mock|sandbox|duplicate key|foreign key|constraint|accessdenied|nosuchkey|nosuchbucket|signaturedoesnotmatch|invalidaccesskeyid)\b|cannot read propert(?:y|ies)|is not defined|has no attribute|<!doctype|<html/i;
const NETWORK_ERROR_PATTERN =
  /\b(failed to fetch|fetch failed|networkerror|network error|network request failed|load failed|request(?:_| )timeout|network connection was lost|internet connection appears to be offline)\b/i;
const INFRASTRUCTURE_ERROR_PATTERN =
  /\b(connection refused|econnrefused|econnreset|errno\s*\d+|seqino_[a-z0-9_]+|piste_[a-z0-9_]+|stripe_[a-z0-9_]+|smtp_[a-z0-9_]+)\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|(?:https?|redis|postgres(?:ql)?|amqp):\/\/|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b|\/(?:srv|app|opt|var|home)\//i;
const DOCUMENT_COMPLIANCE_ERROR_PATTERN =
  /\b(BR-[A-Z0-9-]+|EN16931|Factur-?X|CrossIndustryInvoice|UN\/ECE|UNCEFACT|CII|UBL|Schematron|XSD|XML|namespace-uri|unit code|ChargeIndicator|ApplicableTradeTax|ram:|rsm:)\b/i;

const documentComplianceMessage = (value: string) => {
  if (!DOCUMENT_COMPLIANCE_ERROR_PATTERN.test(value)) return "";
  if (/BR-CL-23|unit code|BilledQuantity|SpecifiedLineTradeDelivery/i.test(value)) {
    return "Une ligne du document contient une unité ou une quantité non acceptée pour l'e-facturation. Vérifiez les lignes, puis relancez l'action.";
  }
  return "Le document n'est pas encore compatible avec le format e-facturation attendu. Vérifiez les informations société/client, les lignes, la TVA et les montants, puis relancez l'action.";
};

const stripDiagnosticSuffix = (value: string) =>
  value
    .replace(/\s*\(id:\s*[^)]*\)\s*$/i, "")
    .replace(/\s*\(location:\s*[^)]*\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

const validationBoundMessage = (value: string) => {
  const clean = stripDiagnosticSuffix(value);
  const lessThan = clean.match(/input should be less than or equal to\s+([0-9]+(?:[.,][0-9]+)?)/i);
  if (lessThan) return `La valeur doit être inférieure ou égale à ${lessThan[1].replace(".", ",")}.`;
  const greaterThan = clean.match(/input should be greater than or equal to\s+([0-9]+(?:[.,][0-9]+)?)/i);
  if (greaterThan) return `La valeur doit être supérieure ou égale à ${greaterThan[1].replace(".", ",")}.`;
  if (/input should be a valid number/i.test(clean)) return "La valeur saisie doit être un nombre valide.";
  return "";
};

const isTechnicalErrorText = (value: string) =>
  TECHNICAL_ERROR_PATTERN.test(value) || NETWORK_ERROR_PATTERN.test(value) || INFRASTRUCTURE_ERROR_PATTERN.test(value);

const isErrorCodeText = (value: string) => {
  const clean = value.trim();
  return /^[a-z][a-z0-9_:-]{2,}$/i.test(clean) && /[_:-]/.test(clean) && !/\s/.test(clean);
};

export const sanitizeUserFacingApiMessage = (value: unknown, status?: number, fallback = DEFAULT_API_ERROR_MESSAGE) => {
  if (typeof status === "number" && status >= 500) return DEFAULT_API_UNAVAILABLE_MESSAGE;
  if (typeof value !== "string") return fallback;
  const clean = stripDiagnosticSuffix(value);
  if (!clean) return fallback;
  if (status === 404 && /^(?:not found|supplier not found)$/i.test(clean)) {
    return fallback !== DEFAULT_API_ERROR_MESSAGE ? fallback : DEFAULT_NOT_FOUND_MESSAGE;
  }
  const complianceMessage = documentComplianceMessage(clean);
  if (complianceMessage) return complianceMessage;
  const structuredInvoiceMessage = sanitizeStructuredInvoiceErrorDetail(clean);
  if (structuredInvoiceMessage) return structuredInvoiceMessage;
  const validationMessage = validationBoundMessage(clean);
  if (validationMessage) return validationMessage;
  if (isErrorCodeText(clean)) return fallback;
  if (isTechnicalErrorText(clean)) return fallback;
  return clean.slice(0, 220);
};

export const extractUserFacingApiMessage = (
  payload: unknown,
  status?: number,
  fallback = DEFAULT_API_ERROR_MESSAGE,
): string => {
  const safeFallback = typeof status === "number" && status >= 500 ? DEFAULT_API_UNAVAILABLE_MESSAGE : fallback;
  if (!payload) return safeFallback;
  if (typeof payload === "string") {
    const parsed = parseMaybeJson(payload);
    return parsed
      ? extractUserFacingApiMessage(parsed, status, safeFallback)
      : sanitizeUserFacingApiMessage(payload, status, safeFallback);
  }
  if (typeof payload !== "object") return safeFallback;

  const obj = payload as Record<string, any>;
  if (obj.error && typeof obj.error === "object") {
    return sanitizeUserFacingApiMessage(obj.error.message || obj.error.detail, status, safeFallback);
  }
  if (typeof obj.error === "string") {
    return sanitizeUserFacingApiMessage(obj.message || obj.detail, status, safeFallback);
  }
  if (obj.detail && typeof obj.detail === "object") {
    return sanitizeUserFacingApiMessage(obj.detail.message || obj.detail.detail, status, safeFallback);
  }
  return sanitizeUserFacingApiMessage(obj.detail || obj.message, status, safeFallback);
};

const extractError = (raw: any, status: number) => {
  const fallback = status >= 500 ? DEFAULT_API_UNAVAILABLE_MESSAGE : DEFAULT_API_ERROR_MESSAGE;
  if (!raw) return { message: fallback };
  if (typeof raw === "string") {
    const parsed = parseMaybeJson(raw);
    if (parsed) return extractError(parsed, status);
    return { message: sanitizeUserFacingApiMessage(raw, status, fallback) };
  }
  if (raw.error) {
    if (typeof raw.error === "string") {
      const message = sanitizeUserFacingApiMessage(raw.message || raw.detail, status, fallback);
      return { message, code: raw.code || raw.error };
    }
    const baseMsg = raw.error.message || raw.error.detail || fallback;
    const message = sanitizeUserFacingApiMessage(baseMsg, status, fallback);
    return { message, code: raw.error.code || raw.error.type };
  }
  if (raw.detail || raw.message || raw.error) {
    const msg = raw.detail || raw.message || raw.error;
    if (typeof msg === "string")
      return { message: sanitizeUserFacingApiMessage(msg, status, fallback), code: raw.code };
    if (typeof msg === "object") {
      return {
        message: sanitizeUserFacingApiMessage(msg.message || msg.detail || fallback, status, fallback),
        code: msg.code || raw.code,
      };
    }
  }
  return { message: fallback };
};

type SessionProblemDetail = {
  code?: string;
  hint?: string;
};

type ApiRequestInit = RequestInit & {
  _retry?: boolean;
  _csrfRetry?: boolean;
  _csrfError?: ApiError;
  timeoutMs?: number;
};

const extractSessionProblem = (raw: any): SessionProblemDetail | null => {
  if (!raw) return null;
  if (typeof raw === "string") {
    const parsed = parseMaybeJson(raw);
    return parsed ? extractSessionProblem(parsed) : null;
  }
  if (raw.detail && typeof raw.detail === "object") {
    return {
      code: raw.detail.code || raw.code,
      hint: raw.detail.hint || undefined,
    };
  }
  if (raw.error && typeof raw.error === "object") {
    return {
      code: raw.error.code || raw.code,
      hint: raw.error.hint || undefined,
    };
  }
  return null;
};

const extractHint = (raw: any): string | null => {
  if (!raw) return null;
  if (typeof raw === "string") {
    const parsed = parseMaybeJson(raw);
    return parsed ? extractHint(parsed) : null;
  }
  if (typeof raw.hint === "string") return raw.hint;
  if (raw.detail && typeof raw.detail.hint === "string") return raw.detail.hint;
  if (raw.error && typeof raw.error.hint === "string") return raw.error.hint;
  return null;
};

const compactApiErrorText = (value: unknown) => {
  let raw = "";
  if (typeof value === "string") {
    raw = value;
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const primary = obj.message || obj.msg || obj.detail || obj.error || obj.field || obj.code;
    raw = typeof primary === "string" ? primary : JSON.stringify(obj);
  } else if (value != null) {
    raw = String(value);
  }
  const complianceMessage = documentComplianceMessage(raw);
  if (complianceMessage) return complianceMessage;
  const structuredInvoiceMessage = sanitizeStructuredInvoiceErrorDetail(value);
  if (structuredInvoiceMessage) return structuredInvoiceMessage;
  return raw ? sanitizeUserFacingApiMessage(raw, 400, "") : "";
};

const formatApiErrorDetails = (err?: ApiError | null) => {
  const rawDetails = Array.isArray(err?.errors) ? err.errors : [];
  const details = rawDetails
    .map(compactApiErrorText)
    .map((item) => item.replace(/[.。]+$/g, ""))
    .filter(Boolean);
  if (!details.length) return "";
  const uniqueDetails = Array.from(new Set(details)).slice(0, 3);
  const suffix = details.length > uniqueDetails.length ? ` (+${details.length - uniqueDetails.length})` : "";
  return `À corriger : ${uniqueDetails.join(" ; ")}${suffix}.`;
};

export const formatApiError = (err: unknown, fallback = DEFAULT_API_ERROR_MESSAGE) => {
  const safeErr = err as ApiError | null;
  const status = typeof safeErr?.status === "number" ? safeErr.status : undefined;
  const message = sanitizeUserFacingApiMessage(safeErr?.message, status, fallback);
  const internalUser = getInternalUser();
  const hint = internalUser ? (safeErr?.hint || safeErr?.help_url || "").toString().trim() : "";
  const validationDetails = formatApiErrorDetails(safeErr);
  const shouldAppendValidationDetails =
    validationDetails && !message.includes(validationDetails) && !validationDetails.includes(message);
  const messageWithDetails = shouldAppendValidationDetails ? `${message} ${validationDetails}` : message;
  if (safeErr?.code === "cookie_config_issue") {
    if (!internalUser) return DEFAULT_SESSION_MESSAGE;
    const cookieHelp = "Front et API doivent partager le même domaine registrable.";
    const debugHelp = safeErr.help_url ? ` Ouvrir ${safeErr.help_url}` : "";
    const details = `${cookieHelp}${debugHelp}`;
    if (!hint || details.includes(hint) || messageWithDetails.includes(hint)) return `${messageWithDetails} ${details}`;
    return `${messageWithDetails} ${details} (${hint})`;
  }
  if (!hint) return messageWithDetails;
  if (messageWithDetails.includes(hint)) return messageWithDetails;
  return `${messageWithDetails} (${hint})`;
};

type HeaderRecord = Record<string, string>;

const normalizeHeaders = (input?: HeadersInit): HeaderRecord => {
  if (!input) return {};
  if (typeof Headers !== "undefined" && input instanceof Headers) {
    const headers: HeaderRecord = {};
    input.forEach((value, key) => {
      headers[key] = value;
    });
    return headers;
  }
  if (Array.isArray(input)) {
    return Object.fromEntries(input);
  }
  return { ...(input as HeaderRecord) };
};

const hasHeader = (headers: HeaderRecord, name: string) => {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
};

const getHeaderValue = (headers: HeaderRecord, name: string) => {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return "";
};

const removeHeader = (headers: HeaderRecord, name: string) => {
  const target = name.toLowerCase();
  Object.keys(headers).forEach((key) => {
    if (key.toLowerCase() === target) delete headers[key];
  });
};

const normalizeCsrfHeader = (headers: HeaderRecord) => {
  const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() === "x-csrf-token");
  if (!entries.length) return;
  const token = entries.map(([, value]) => value).find((value) => value && value.trim()) || "";
  removeHeader(headers, "x-csrf-token");
  if (token) headers["X-CSRF-Token"] = token;
};

const isFormDataBody = (body: any): body is FormData => {
  return typeof FormData !== "undefined" && body instanceof FormData;
};

const buildHeaders = (opts: RequestInit, setJsonContentType = true) => {
  const headers = normalizeHeaders(opts.headers);
  const isFormData = isFormDataBody(opts.body);
  if (isFormData) {
    removeHeader(headers, "content-type");
  } else if (setJsonContentType && !hasHeader(headers, "content-type")) {
    headers["Content-Type"] = "application/json";
  }
  return { headers, isFormData };
};

type RefreshResult = "cookie" | "bearer" | null;

let refreshing: Promise<RefreshResult> | null = null;
let csrfRefreshing: Promise<string | null> | null = null;
let lastSessionProblem: SessionProblemDetail | null = null;
let sessionProblemShown = false;
let csrfProblemShown = false;
const REFRESH_LOCK_KEY = "pixfacture:auth-refresh-lock";
const REFRESH_RESULT_KEY = "pixfacture:auth-refresh-result";
const REFRESH_WEB_LOCK_KEY = "pixfacture-auth-refresh";
const REFRESH_LOCK_TTL_MS = 15000;
const REFRESH_LOCK_POLL_MS = 160;
const REFRESH_RESULT_TTL_MS = 5000;
const refreshOwner =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const AUTH_SKIP = [
  "/api/auth/refresh",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/logout",
  "/api/auth/google",
  "/api/auth/csrf",
  "/api/auth/password-reset",
  "/api/auth/password-reset/confirm",
  "/api/users/invites/accept",
  "/api/users/invite/accept",
];
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MESSAGE = "Le chargement prend trop de temps. Vérifiez la connexion puis réessayez.";

const isMutatingMethod = (method?: string) => {
  const m = (method || "GET").toUpperCase();
  return ["POST", "PUT", "PATCH", "DELETE"].includes(m);
};

const hideDevPages = shouldHideDevPages();
const GENERIC_SESSION_MESSAGE = "Votre session ne peut pas être confirmée. Rechargez la page puis reconnectez-vous.";
const COOKIE_CONFIG_USER_MESSAGE = "Votre session ne peut pas être confirmée. Rechargez la page puis reconnectez-vous.";
const CSRF_HELP_URL = hideDevPages ? "" : "/app/diagnostic";
const COOKIE_CONFIG_HELP_URL = hideDevPages ? "" : "/app/session-debug";
const buildCsrfHelpMessage = (isInternal: boolean) => {
  if (!isInternal) return GENERIC_SESSION_MESSAGE;
  return hideDevPages
    ? "Session sécurisée : vérifiez que l’app est déployée sur le même domaine ou que les cookies tiers sont autorisés."
    : "Session sécurisée : vérifiez que l’app est déployée sur le même domaine ou que les cookies tiers sont autorisés. Diagnostic : /app/diagnostic (si connecté).";
};
const buildCookieConfigMessage = () => COOKIE_CONFIG_USER_MESSAGE;
const logApiDiagnostic = (label: string, payload: Record<string, unknown>) => {
  if (!isDevEnv || typeof console === "undefined") return;
  console.warn(`[api] ${label}`, payload);
};
const requestLabel = (input: RequestInfo | URL) => {
  if (typeof input === "string") return input;
  if (typeof URL !== "undefined" && input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url || "";
  return "";
};
const buildRequestTimeoutError = (timeoutMs: number, input: RequestInfo | URL) => {
  const err = new Error(REQUEST_TIMEOUT_MESSAGE) as ApiError;
  err.code = "request_timeout";
  err.status = 0;
  err.hint = `Réponse attendue sous ${Math.round(timeoutMs / 1000)}s maximum.`;
  const label = requestLabel(input);
  if (label) {
    err.remediation_url = label;
  }
  return err;
};

export async function fetchWithTimeout(input: RequestInfo | URL, opts: RequestInit & { timeoutMs?: number } = {}) {
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal, ...requestOpts } = opts;
  if (!timeoutMs || timeoutMs <= 0 || typeof AbortController === "undefined") {
    return await fetch(input, { ...requestOpts, signal });
  }

  const controller = new AbortController();
  let timedOut = false;
  const relayAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) relayAbort();
    else signal.addEventListener("abort", relayAbort, { once: true });
  }
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...requestOpts, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      const label = requestLabel(input);
      logApiDiagnostic("request_timeout", {
        request: label || "unknown",
        timeout_ms: timeoutMs,
      });
      throw buildRequestTimeoutError(timeoutMs, input);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", relayAbort);
  }
}
const LOGIN_NOTICE_KEY = "login_notice";
const SESSION_EXPIRED_NOTICE = "Session expirée, merci de vous reconnecter.";
const MFA_SETUP_REQUIRED_NOTICE = "Double authentification requise. Reconnectez-vous pour terminer son activation.";
const SESSION_PROBLEM_MODAL_ID = "session-problem-modal";
const CSRF_PROBLEM_MODAL_ID = "csrf-problem-modal";
const GENERIC_CSRF_MESSAGE = "Requête refusée pour raison de sécurité. Rechargez la page puis réessayez.";
const SESSION_CHECKLIST = [
  "Même domaine registrable (ex: app.example.com + api.example.com)",
  "HTTPS obligatoire en production",
  "Cookies inter-domaines explicitement autorisés si l’app et le service sont séparés",
  "Origine de l’application autorisée côté service",
];
const CSRF_CHECKLIST = [
  "Même domaine registrable (ex: app.example.com + api.example.com)",
  "HTTPS obligatoire en production",
  "Jeton de sécurité de session présent",
  "Origine de l’application autorisée côté service",
];

const hintIndicatesCookies = (hint?: string | null) => {
  if (!hint) return false;
  return /cookie|samesite|domain|secure|cors|reverse-proxy/i.test(hint);
};

const messageMentionsCsrf = (message?: string | null) => {
  if (!message) return false;
  return /csrf/i.test(message);
};

const normalizeCode = (code?: string | null) => {
  return (code || "").toString().toLowerCase();
};

const isCsrfIssue = (params: { status: number; code?: string | null; message?: string | null }) => {
  if (params.status !== 403) return false;
  const code = normalizeCode(params.code);
  if (code.startsWith("csrf_")) return true;
  return messageMentionsCsrf(params.message);
};

const isCsrfRetryable = (params: { status: number; code?: string | null; message?: string | null }) => {
  if (params.status !== 403) return false;
  const code = normalizeCode(params.code);
  if (code.startsWith("csrf_")) return true;
  return messageMentionsCsrf(params.message);
};

const SESSION_EXPIRED_CODES = new Set([
  "token_invalid",
  "invalid_token",
  "expired_token",
  "token_missing",
  "session_expired",
]);

const isSessionExpired = (params: {
  status: number;
  isAuthRoute: boolean;
  cookieConfigIssue: boolean;
  code?: string | null;
  message?: string | null;
}) => {
  if (params.status !== 401) return false;
  if (params.isAuthRoute) return false;
  if (params.cookieConfigIssue) return false;
  const code = (params.code || "").toString().toLowerCase();
  if (SESSION_EXPIRED_CODES.has(code)) return true;
  const message = (params.message || "").toString().toLowerCase();
  return message.includes("expir");
};

type ApiErrorParams = {
  message: string;
  status: number;
  cookieConfigIssue: boolean;
  sessionExpired: boolean;
  sessionCodeRaw?: string | null;
  forbidden: boolean;
  errorHint?: string | null;
  csrfIssue: boolean;
  raw?: any;
};

const buildApiError = (params: ApiErrorParams): ApiError => {
  const err = new Error(params.message) as ApiError;
  err.code = params.cookieConfigIssue
    ? "cookie_config_issue"
    : params.sessionExpired
      ? "session_expired"
      : params.sessionCodeRaw || (params.forbidden ? "forbidden" : undefined);
  const isInternal = process.env.NODE_ENV !== "production" && getInternalUser();
  if (params.errorHint) err.hint = params.errorHint;
  if (params.csrfIssue && isInternal) err.help_url = CSRF_HELP_URL;
  if (params.cookieConfigIssue && isInternal) err.help_url = COOKIE_CONFIG_HELP_URL;
  err.status = params.status;
  const raw = params.raw;
  if (raw && typeof raw === "object" && raw.error && raw.error.error_id) {
    err.error_id = raw.error.error_id;
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as any).errors)) {
    err.errors = (raw as any).errors;
  }
  if (raw && typeof raw === "object" && raw.error && typeof (raw as any).error === "object") {
    const nestedError = (raw as any).error;
    if (!err.errors && Array.isArray(nestedError.errors)) err.errors = nestedError.errors;
    if (!err.fields && Array.isArray(nestedError.fields)) err.fields = nestedError.fields;
    if (!err.code && nestedError.code) err.code = nestedError.code;
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as any).fields)) {
    err.fields = (raw as any).fields;
  }
  if (raw && typeof raw === "object" && raw.detail && typeof (raw as any).detail === "object") {
    const detail = (raw as any).detail;
    if (!err.errors && Array.isArray(detail)) err.errors = detail;
    if (!err.errors && Array.isArray(detail.errors)) err.errors = detail.errors;
    if (Array.isArray(detail.fields)) err.fields = detail.fields;
    if (!err.fields && detail.field) err.fields = [detail.field];
    if (detail.code && !err.code) err.code = detail.code;
  }
  if (raw && typeof raw === "object") {
    const remediationUrl =
      (raw as any).remediation_url || (raw as any).detail?.remediation_url || (raw as any).error?.remediation_url;
    if (!err.remediation_url && typeof remediationUrl === "string" && remediationUrl.trim()) {
      err.remediation_url = remediationUrl.trim();
    }
    const helpUrl = (raw as any).help_url || (raw as any).detail?.help_url || (raw as any).error?.help_url;
    if (!err.help_url && typeof helpUrl === "string" && helpUrl.trim()) {
      err.help_url = helpUrl.trim();
    }
  }
  if (raw && typeof raw === "object") {
    const required = (raw as any).required || (raw as any).detail?.required || (raw as any).error?.required;
    if (Array.isArray(required)) {
      err.required = required;
    }
  }
  return err;
};

async function ensureCsrfToken() {
  if (!isCookieAuthMode()) return null;
  if (csrfRefreshing) return csrfRefreshing;
  csrfRefreshing = (async () => {
    return await getCsrfToken();
  })();
  try {
    return await csrfRefreshing;
  } finally {
    csrfRefreshing = null;
  }
}

async function getRefreshCsrfToken() {
  return getCsrfToken();
}

function showSessionProblemModal(problem?: SessionProblemDetail | null) {
  if (typeof document === "undefined") return;
  if (sessionProblemShown) return;
  if (!document.body) return;
  sessionProblemShown = true;
  const isInternal = process.env.NODE_ENV !== "production" && getInternalUser();
  const root = document.createElement("div");
  root.id = SESSION_PROBLEM_MODAL_ID;
  root.className = "session-overlay";

  const hintBlock = isInternal ? '<div class="alert-inline danger mt-10" data-session-hint hidden></div>' : "";
  const checklistBlock = isInternal
    ? `<ul class="session-checklist mt-10">
        ${SESSION_CHECKLIST.map((item) => `<li>${item}</li>`).join("")}
      </ul>`
    : "";
  const actionLink =
    !hideDevPages && isInternal
      ? '<a class="btn secondary" href="/app/session-debug">Ouvrir le diagnostic session</a>'
      : "";
  const message = isInternal
    ? "La session n'a pas pu être rafraîchie. Front + API doivent partager le même domaine registrable ou utiliser SameSite=None + Secure."
    : GENERIC_SESSION_MESSAGE;

  root.innerHTML = `
    <div class="card session-modal" role="dialog" aria-modal="true" aria-label="Session à vérifier">
      <div class="session-modal__header">
        <div>
          <div class="pill muted">Session</div>
          <h3 class="session-modal__title">Session à vérifier</h3>
        </div>
        <button class="icon-button" aria-label="Fermer" data-session-close type="button">✕</button>
      </div>

      <p class="muted session-modal__message">
        ${message}
      </p>

      ${hintBlock}
      ${checklistBlock}

      <div class="session-modal__actions">
        ${actionLink}
        <button class="btn ghost" type="button" data-session-close-alt>Fermer</button>
      </div>
    </div>
  `;

  const hintEl = root.querySelector("[data-session-hint]") as HTMLDivElement | null;
  if (hintEl && problem?.hint) {
    hintEl.textContent = `Indice API : ${problem.hint}`;
    hintEl.hidden = false;
  }

  const close = () => {
    root.remove();
  };

  root.addEventListener("click", (evt) => {
    if (evt.target === root) close();
  });
  root.querySelectorAll("[data-session-close], [data-session-close-alt]").forEach((el) => {
    el.addEventListener("click", close);
  });

  document.body.appendChild(root);
}

function showCsrfProblemModal(problem?: { code?: string | null; hint?: string | null } | null) {
  if (typeof document === "undefined") return;
  if (csrfProblemShown) return;
  if (!document.body) return;
  csrfProblemShown = true;
  const isInternal = process.env.NODE_ENV !== "production" && getInternalUser();
  const root = document.createElement("div");
  root.id = CSRF_PROBLEM_MODAL_ID;
  root.className = "session-overlay";

  const hintBlock = isInternal ? '<div class="alert-inline danger mt-10" data-csrf-hint hidden></div>' : "";
  const checklistBlock = isInternal
    ? `<ul class="session-checklist mt-10">
        ${CSRF_CHECKLIST.map((item) => `<li>${item}</li>`).join("")}
      </ul>`
    : "";

  const message = isInternal
    ? "Le jeton de sécurité de session n'a pas pu être validé. Vérifiez les domaines, les cookies et la configuration du proxy."
    : GENERIC_CSRF_MESSAGE;

  root.innerHTML = `
    <div class="card session-modal" role="dialog" aria-modal="true" aria-label="Action refusée">
      <div class="session-modal__header">
        <div>
          <div class="pill muted">Sécurité</div>
          <h3 class="session-modal__title">Action refusée</h3>
        </div>
        <button class="icon-button" aria-label="Fermer" data-csrf-close type="button">✕</button>
      </div>

      <p class="muted session-modal__message">
        ${message}
      </p>

      ${hintBlock}
      ${checklistBlock}

      <div class="session-modal__actions">
        <button class="btn ghost" type="button" data-csrf-close-alt>Fermer</button>
      </div>
    </div>
  `;

  const hintEl = root.querySelector("[data-csrf-hint]") as HTMLDivElement | null;
  if (hintEl && (problem?.hint || problem?.code)) {
    const code = (problem?.code || "").toString();
    const hint = (problem?.hint || "").toString();
    hintEl.textContent = `Indice API : ${[code, hint].filter(Boolean).join(" — ")}`;
    hintEl.hidden = false;
  }

  const close = () => {
    root.remove();
  };

  root.addEventListener("click", (evt) => {
    if (evt.target === root) close();
  });
  root.querySelectorAll("[data-csrf-close], [data-csrf-close-alt]").forEach((el) => {
    el.addEventListener("click", close);
  });

  document.body.appendChild(root);
}

const setLoginNotice = (message: string) => {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(LOGIN_NOTICE_KEY, message);
  } catch {
    // ignore storage failures
  }
};

const redirectToLoginWithReturnTo = (message: string, returnTo?: string | null) => {
  setLoginNotice(message);
  if (typeof window === "undefined") {
    logout({ returnTo });
    return;
  }
  const current =
    returnTo || `${window.location.pathname || ""}${window.location.search || ""}${window.location.hash || ""}`;
  logout({ returnTo: current });
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const readJsonStorage = (key: string) => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeJsonStorage = (key: string, value: unknown) => {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

const removeStorageKey = (key: string) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore storage failures
  }
};

const storedRefreshResult = (result: any, minTs = 0): RefreshResult | undefined => {
  const ts = typeof result?.ts === "number" ? result.ts : 0;
  if (!ts || result.owner === refreshOwner) return undefined;
  if (Date.now() - ts > REFRESH_RESULT_TTL_MS) return undefined;
  if (ts < minTs && Date.now() - ts > REFRESH_LOCK_POLL_MS * 4) return undefined;
  if (result.value === "cookie") {
    clearCachedCsrfToken();
    return "cookie";
  }
  if (result.value === "bearer") return "bearer";
  return null;
};

const canCoordinateRefresh = () => {
  if (typeof window === "undefined") return false;
  const key = `${REFRESH_LOCK_KEY}:probe`;
  try {
    window.localStorage.setItem(key, refreshOwner);
    const ok = window.localStorage.getItem(key) === refreshOwner;
    window.localStorage.removeItem(key);
    return ok;
  } catch {
    return false;
  }
};

const acquireRefreshLock = () => {
  if (typeof window === "undefined") return false;
  const now = Date.now();
  const lock = readJsonStorage(REFRESH_LOCK_KEY);
  if (lock?.owner && typeof lock.ts === "number" && now - lock.ts < REFRESH_LOCK_TTL_MS) {
    return false;
  }
  if (!writeJsonStorage(REFRESH_LOCK_KEY, { owner: refreshOwner, ts: now })) return false;
  const confirmed = readJsonStorage(REFRESH_LOCK_KEY);
  return confirmed?.owner === refreshOwner;
};

const releaseRefreshLock = () => {
  const lock = readJsonStorage(REFRESH_LOCK_KEY);
  if (lock?.owner === refreshOwner) removeStorageKey(REFRESH_LOCK_KEY);
};

const waitForRefreshLock = async (startedAt: number): Promise<RefreshResult> => {
  if (typeof window === "undefined") return null;
  const deadline = startedAt + REFRESH_LOCK_TTL_MS + 2000;
  while (Date.now() < deadline) {
    const result = storedRefreshResult(readJsonStorage(REFRESH_RESULT_KEY), startedAt);
    if (result !== undefined) return result;
    const lock = readJsonStorage(REFRESH_LOCK_KEY);
    if (!lock?.owner) {
      await sleep(REFRESH_LOCK_POLL_MS);
      const lateResult = storedRefreshResult(readJsonStorage(REFRESH_RESULT_KEY), startedAt);
      if (lateResult !== undefined) return lateResult;
      return null;
    }
    await sleep(REFRESH_LOCK_POLL_MS);
  }
  return null;
};

const withWebRefreshLock = async (task: () => Promise<RefreshResult>): Promise<RefreshResult | undefined> => {
  if (typeof navigator === "undefined" || !isCookieAuthMode()) return undefined;
  const locks = (
    navigator as Navigator & {
      locks?: {
        request<T>(name: string, options: { mode: "exclusive" }, callback: () => T | Promise<T>): Promise<T>;
      };
    }
  ).locks;
  if (!locks?.request) return undefined;
  const startedAt = Date.now();
  return locks.request(REFRESH_WEB_LOCK_KEY, { mode: "exclusive" }, async () => {
    const recent = storedRefreshResult(readJsonStorage(REFRESH_RESULT_KEY), startedAt);
    if (recent !== undefined) return recent;
    const value = await task();
    writeJsonStorage(REFRESH_RESULT_KEY, { owner: refreshOwner, ts: Date.now(), value });
    return value;
  });
};

const withRefreshLock = async (task: () => Promise<RefreshResult>): Promise<RefreshResult> => {
  const webLockResult = await withWebRefreshLock(task);
  if (webLockResult !== undefined) return webLockResult;
  if (typeof window === "undefined" || !isCookieAuthMode() || !canCoordinateRefresh()) return task();
  const startedAt = Date.now();
  if (!acquireRefreshLock()) {
    return waitForRefreshLock(startedAt);
  }
  try {
    const value = await task();
    writeJsonStorage(REFRESH_RESULT_KEY, { owner: refreshOwner, ts: Date.now(), value });
    return value;
  } finally {
    releaseRefreshLock();
  }
};

export async function refreshSession(timeoutMs?: number) {
  if (refreshing) return refreshing;
  refreshing = withRefreshLock(async () => {
    if (!isCookieAuthMode()) {
      const refreshToken = getRefreshToken();
      if (!refreshToken) return null;
      const res = await fetchWithTimeout(buildApiUrl("/api/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
        credentials: defaultAuthCredentials(),
        cache: "no-store",
        timeoutMs,
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      const accessToken = data?.access_token || "";
      const nextRefreshToken = data?.refresh_token || "";
      if (!accessToken) return null;
      setAuthTokens({ accessToken, refreshToken: nextRefreshToken, persist: true });
      return "bearer";
    }

    let csrf = await getRefreshCsrfToken();
    let csrfRetried = false;
    for (;;) {
      const res = await fetchWithTimeout(buildApiUrl("/api/auth/refresh"), {
        method: "POST",
        headers: csrf ? { "X-CSRF-Token": csrf } : undefined,
        credentials: "include",
        cache: "no-store",
        timeoutMs,
      });
      if (res.ok) {
        lastSessionProblem = null;
        clearCachedCsrfToken();
        return "cookie";
      }
      const ct = res.headers.get("content-type") || "";
      let raw: any = null;
      if (ct.includes("application/json")) {
        raw = await res.json().catch(() => null);
      } else {
        const text = await res.text().catch(() => null);
        raw = parseMaybeJson(text) ?? text;
      }
      const { message, code } = extractError(raw ?? res.statusText, res.status);
      const problem = extractSessionProblem(raw);
      const sessionCodeRaw = (problem?.code || code || "").toString();
      const csrfIssue = isCsrfIssue({ status: res.status, code: sessionCodeRaw, message });
      if (csrfIssue && !csrfRetried) {
        csrfRetried = true;
        csrf = await getCsrfToken({ force: true });
        continue;
      }
      const cookieIssue =
        problem?.code === "cookie_config_issue" ||
        (problem?.code === "token_missing" && hintIndicatesCookies(problem?.hint));
      const sessionExpiredCode = (problem?.code || "").toString().toLowerCase();
      if (res.status === 401 && SESSION_EXPIRED_CODES.has(sessionExpiredCode) && !cookieIssue) {
        lastSessionProblem = problem;
        return null;
      }
      lastSessionProblem = problem;
      showSessionProblemModal(lastSessionProblem);
      return null;
    }
  });
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

export async function refreshAccessToken() {
  return refreshSession();
}

export async function rawApi(path: string, opts: RequestInit = {}) {
  const url = buildApiUrl(path);
  const { timeoutMs, _retry, ...requestOpts } = opts as RequestInit & { timeoutMs?: number; _retry?: boolean };
  const isAuthRoute = AUTH_SKIP.some((p) => path.startsWith(p));
  const { headers } = buildHeaders(requestOpts, false);
  if (isCookieAuthMode()) {
    removeHeader(headers, "authorization");
  } else if (!isAuthRoute && !hasHeader(headers, "authorization")) {
    Object.assign(headers, getAuthHeader());
  }
  const res = await fetchWithTimeout(url, {
    ...requestOpts,
    headers,
    cache: requestOpts.cache ?? "no-store",
    credentials: requestOpts.credentials ?? defaultAuthCredentials(),
    timeoutMs,
  });
  if (res.status === 401 && !isAuthRoute && !_retry) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return rawApi(path, { ...requestOpts, timeoutMs, _retry: true } as RequestInit & {
        timeoutMs?: number;
        _retry?: boolean;
      });
    }
  }
  return res;
}

export async function apiFetch(path: string, opts: ApiRequestInit = {}) {
  const url = buildApiUrl(path);
  const isAuthRoute = AUTH_SKIP.some((p) => path.startsWith(p));
  const { _retry, _csrfRetry, _csrfError, timeoutMs, ...requestOpts } = opts;
  const { headers } = buildHeaders(requestOpts);
  const cookieMode = isCookieAuthMode();
  const method = (requestOpts.method || "GET").toUpperCase();
  if (cookieMode) {
    removeHeader(headers, "authorization");
    normalizeCsrfHeader(headers);
  } else if (!isAuthRoute && !hasHeader(headers, "authorization")) {
    Object.assign(headers, getAuthHeader());
  }
  if (cookieMode && isMutatingMethod(method) && !hasHeader(headers, "x-csrf-token")) {
    const csrf = await ensureCsrfToken();
    headers["X-CSRF-Token"] = csrf || "";
    if (!csrf) {
      logApiDiagnostic("csrf_token_missing", { path, method, apiOrigin: apiOriginFn() });
    }
  }
  const res = await fetchWithTimeout(url, {
    ...requestOpts,
    headers,
    cache: requestOpts.cache ?? "no-store",
    credentials: requestOpts.credentials ?? defaultAuthCredentials(),
    timeoutMs,
  });

  const ct = res.headers.get("content-type") || "";
  const isJson = ct.includes("application/json");

  if (!res.ok) {
    const raw = isJson ? await res.json().catch(() => null) : await res.text().catch(() => null);
    const { message, code } = extractError(raw ?? res.statusText, res.status);
    const sessionProblem = extractSessionProblem(raw);
    const errorHint = extractHint(raw) || sessionProblem?.hint || null;
    const sessionCodeRaw = (sessionProblem?.code || code || "").toString();
    const csrfHeaderValue = getHeaderValue(headers, "x-csrf-token");
    if (cookieMode && method === "POST" && res.status === 401 && typeof console !== "undefined") {
      const csrfRequired = res.headers.get("x-csrf-required");
      console.warn("[api] cookie auth POST 401", {
        cookieMode: true,
        apiOrigin: apiOriginFn(),
        "x-csrf-required": csrfRequired || null,
        hasCsrfToken: Boolean((csrfHeaderValue || "").trim()),
        status: res.status,
        error_code: sessionCodeRaw || null,
      });
    }
    const sessionCode = sessionCodeRaw.toLowerCase();
    const sessionHint = sessionProblem?.hint || null;
    const normalized = (message || "").toString();
    const normalizedLower = normalized.toLowerCase();
    if (isDevEnv && (res.status === 401 || res.status === 403)) {
      console.assert(Boolean(sessionCodeRaw), "[api] code d’erreur manquant", {
        path,
        method,
        status: res.status,
        message: normalized || res.statusText,
      });
    }
    const isUnauthorized = res.status === 401;
    const cookieConfigIssue =
      isUnauthorized &&
      !isAuthRoute &&
      (sessionCode === "cookie_config_issue" || (sessionCode === "token_missing" && hintIndicatesCookies(sessionHint)));
    const sessionExpired = isSessionExpired({
      status: res.status,
      isAuthRoute,
      cookieConfigIssue,
      code: sessionCodeRaw,
      message: normalizedLower,
    });
    const forbidden = res.status === 403;
    const mfaSetupRequired =
      forbidden && sessionCode === "mfa_setup_required" && !isAuthRoute && !path.startsWith("/api/auth/mfa/");
    const csrfCode = (sessionCodeRaw || code || "").toString();
    const csrfIssue = cookieMode && isCsrfIssue({ status: res.status, code: csrfCode, message: normalized });
    const csrfRetryable = cookieMode && isCsrfRetryable({ status: res.status, code: csrfCode, message: normalized });
    const internalUser = getInternalUser();
    if (cookieConfigIssue) {
      logApiDiagnostic("cookie_config_issue", {
        path,
        method,
        status: res.status,
        apiOrigin: apiOriginFn(),
        error_code: sessionCodeRaw || null,
        hint: errorHint || null,
      });
    }
    if (csrfIssue) {
      logApiDiagnostic("csrf_issue", {
        path,
        method,
        status: res.status,
        apiOrigin: apiOriginFn(),
        error_code: csrfCode || null,
        hasCsrfToken: Boolean((csrfHeaderValue || "").trim()),
      });
    }
    const sessionMessage = cookieConfigIssue
      ? buildCookieConfigMessage()
      : internalUser
        ? SESSION_EXPIRED_NOTICE
        : GENERIC_SESSION_MESSAGE;
    const finalMessage =
      !isAuthRoute && isUnauthorized
        ? sessionMessage
        : csrfIssue
          ? buildCsrfHelpMessage(internalUser)
          : normalized || sanitizeUserFacingApiMessage(res.statusText, res.status, DEFAULT_API_ERROR_MESSAGE);
    const baseError = buildApiError({
      message: finalMessage,
      status: res.status,
      cookieConfigIssue,
      sessionExpired,
      sessionCodeRaw,
      forbidden,
      errorHint,
      csrfIssue,
      raw,
    });
    const csrfRetryFailed = Boolean(_csrfRetry) && csrfIssue && isMutatingMethod(method);
    if (csrfRetryFailed) {
      logApiDiagnostic("csrf_retry_failed", {
        path,
        method,
        status: res.status,
        error_code: csrfCode || null,
        hasCsrfToken: Boolean((csrfHeaderValue || "").trim()),
      });
      showCsrfProblemModal({ code: csrfCode, hint: errorHint });
    }
    const finalError = _csrfRetry && _csrfError && csrfIssue ? _csrfError : baseError;

    // Tentative silencieuse de refresh pour les appels protégés
    if (isUnauthorized && !isAuthRoute) {
      if (!_retry && sessionExpired) {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          return apiFetch(path, { ...opts, _retry: true, headers } as ApiRequestInit);
        }
      }
      // Refresh impossible ou déjà tenté, on invalide la session
      if (sessionExpired && !cookieConfigIssue) {
        redirectToLoginWithReturnTo(SESSION_EXPIRED_NOTICE);
      }
    }
    if (mfaSetupRequired) {
      redirectToLoginWithReturnTo(MFA_SETUP_REQUIRED_NOTICE);
    }

    if (csrfRetryable && isMutatingMethod(method)) {
      if (!_csrfRetry) {
        const refreshed = await getCsrfToken({ force: true });
        const retryHeaders = { ...headers };
        if (refreshed) {
          removeHeader(retryHeaders, "x-csrf-token");
          retryHeaders["X-CSRF-Token"] = refreshed;
        }
        return apiFetch(path, {
          ...opts,
          _csrfRetry: true,
          _csrfError: baseError,
          headers: retryHeaders,
        } as ApiRequestInit);
      }
      throw finalError;
    }

    throw finalError;
  }

  return isJson ? res.json() : res.text();
}

export const api = apiFetch;
export const fetchJson = apiFetch;

export async function apiUpload(path: string, formData: FormData) {
  return apiFetch(path, { method: "POST", body: formData });
}
