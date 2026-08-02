import subprocessorsData from "@/data/subprocessors.json";

export type Subprocessor = {
  name: string;
  purpose: string;
  location?: string;
  website?: string;
  dp_link?: string;
  notes?: string;
  safeguards?: string;
  relationship?: string;
  lastUpdated?: string;
};

const normalizeSubprocessors = (items: Subprocessor[]): Subprocessor[] => {
  return items
    .map((item) => ({
      name: String(item?.name || "").trim(),
      purpose: String(item?.purpose || "").trim(),
      location: String(item?.location || "").trim() || undefined,
      website: String(item?.website || "").trim() || undefined,
      dp_link: String(item?.dp_link || "").trim() || undefined,
      notes: String(item?.notes || "").trim() || undefined,
      safeguards: String(item?.safeguards || "").trim() || undefined,
      relationship: String(item?.relationship || "").trim() || undefined,
      lastUpdated: String(item?.lastUpdated || "").trim() || undefined,
    }))
    .filter((item) => item.name && item.purpose);
};

const parseSubprocessors = (defaultList: Subprocessor[]): Subprocessor[] => {
  const raw = (process.env.NEXT_PUBLIC_LEGAL_SUBPROCESSORS || "").trim();
  if (!raw) return defaultList;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultList;
    return normalizeSubprocessors(parsed);
  } catch {
    return defaultList;
  }
};

const baseFromFile = normalizeSubprocessors(Array.isArray(subprocessorsData) ? subprocessorsData : []);

export const SUBPROCESSORS = parseSubprocessors(baseFromFile);

const parseDateValue = (value: string | undefined): number | null => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
};

const resolveLastUpdated = (items: Subprocessor[]): string | null => {
  let latest: { raw: string; time: number } | null = null;
  for (const item of items) {
    const raw = String(item.lastUpdated || "").trim();
    if (!raw) continue;
    const time = parseDateValue(raw);
    if (time === null) continue;
    if (!latest || time > latest.time) {
      latest = { raw, time };
    }
  }
  return latest ? latest.raw : null;
};

export const SUBPROCESSORS_LAST_UPDATED = resolveLastUpdated(SUBPROCESSORS);

export const formatSubprocessorDate = (value?: string | null): string | null => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const datePart = raw.split("T")[0];
  const parts = datePart.split("-");
  if (parts.length === 3 && parts[0].length === 4) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return raw;
};
