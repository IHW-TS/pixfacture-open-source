import "server-only";

type ServerJsonResult<T = any> = {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
};

type ServerResponseResult = {
  ok: boolean;
  status: number;
  response: Response | null;
  error: string | null;
};

const DEFAULT_SERVER_FETCH_TIMEOUT_MS = 8000;

function serverFetchTimeoutMs() {
  const configured = Number(process.env.SERVER_API_FETCH_TIMEOUT_MS || "");
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SERVER_FETCH_TIMEOUT_MS;
}

function normalizeBaseUrl(value: string | undefined | null) {
  const raw = String(value || "")
    .trim()
    .replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

export function getServerBaseUrl() {
  const candidates = [process.env.FRONTEND_BASE_URL, process.env.PUBLIC_BASE_URL, process.env.NEXT_PUBLIC_API_ORIGIN];

  for (const candidate of candidates) {
    const normalized = normalizeBaseUrl(candidate);
    if (normalized) return normalized;
  }

  return "http://localhost:3000";
}

function getServerBaseCandidates(path: string) {
  const isApiPath = path.startsWith("/api/");
  const publicCandidates = [
    process.env.API_ORIGIN,
    process.env.FRONTEND_BASE_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.NEXT_PUBLIC_API_ORIGIN,
  ];
  const internalCandidates = isApiPath
    ? [process.env.INTERNAL_API_ORIGIN, process.env.API_INTERNAL_ORIGIN, "http://backend:8000"]
    : [];

  const normalized = [...publicCandidates, ...internalCandidates]
    .map((value) => normalizeBaseUrl(value))
    .filter(Boolean);

  return Array.from(new Set(normalized));
}

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const timeoutMs = serverFetchTimeoutMs();
  const controller = new AbortController();
  const signal = init.signal;
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, timeoutMs);

  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }

  try {
    return await fetch(url, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export async function fetchServerJson<T = any>(path: string, init: RequestInit = {}): Promise<ServerJsonResult<T>> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const candidates = getServerBaseCandidates(normalizedPath);
  const fallbackBaseUrl = getServerBaseUrl();
  if (!candidates.includes(fallbackBaseUrl)) {
    candidates.push(fallbackBaseUrl);
  }

  let lastError: string | null = null;

  for (const baseUrl of candidates) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}${normalizedPath}`, init);
      const data = (await res.json().catch(() => null)) as T | null;

      if (res.ok || (res.status >= 400 && res.status < 500)) {
        return {
          ok: res.ok,
          status: res.status,
          data,
          error: res.ok ? null : res.statusText || "HTTP error",
        };
      }

      lastError = res.statusText || `HTTP ${res.status}`;
    } catch (error) {
      lastError =
        error instanceof Error && error.name === "AbortError"
          ? "Server fetch timeout"
          : error instanceof Error
            ? error.message
            : "Server fetch error";
    }
  }

  return {
    ok: false,
    status: 0,
    data: null,
    error: lastError,
  };
}

export async function fetchServerResponse(path: string, init: RequestInit = {}): Promise<ServerResponseResult> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const candidates = getServerBaseCandidates(normalizedPath);
  const fallbackBaseUrl = getServerBaseUrl();
  if (!candidates.includes(fallbackBaseUrl)) {
    candidates.push(fallbackBaseUrl);
  }

  let lastError: string | null = null;

  for (const baseUrl of candidates) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}${normalizedPath}`, init);

      if (res.ok || (res.status >= 400 && res.status < 500)) {
        return {
          ok: res.ok,
          status: res.status,
          response: res,
          error: res.ok ? null : res.statusText || "HTTP error",
        };
      }

      lastError = res.statusText || `HTTP ${res.status}`;
    } catch (error) {
      lastError =
        error instanceof Error && error.name === "AbortError"
          ? "Server fetch timeout"
          : error instanceof Error
            ? error.message
            : "Server fetch error";
    }
  }

  return {
    ok: false,
    status: 0,
    response: null,
    error: lastError,
  };
}
