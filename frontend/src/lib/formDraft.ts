const DRAFT_PREFIX = "draft:";
const DEFAULT_TTL_MINUTES = 60;

const buildKey = (key: string) => `${DRAFT_PREFIX}${key}`;

const now = () => Date.now();

export function saveDraft<T>(key: string, data: T, ttlMinutes = DEFAULT_TTL_MINUTES) {
  if (typeof window === "undefined") return;
  if (!key) return;
  try {
    const ttl = Number.isFinite(ttlMinutes) ? Math.max(1, ttlMinutes) : DEFAULT_TTL_MINUTES;
    const savedAt = now();
    const payload = {
      data,
      savedAt,
      expiresAt: savedAt + ttl * 60 * 1000,
    };
    sessionStorage.setItem(buildKey(key), JSON.stringify(payload));
  } catch {
    // ignore storage failures
  }
}

export function loadDraft<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(buildKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const expiresAt = Number(parsed.expiresAt);
    if (!Number.isFinite(expiresAt) || now() > expiresAt) {
      sessionStorage.removeItem(buildKey(key));
      return null;
    }
    return parsed.data as T;
  } catch {
    return null;
  }
}

export function clearDraft(key: string) {
  if (typeof window === "undefined") return;
  if (!key) return;
  try {
    sessionStorage.removeItem(buildKey(key));
  } catch {
    // ignore storage failures
  }
}
