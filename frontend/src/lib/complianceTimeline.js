const PLACEHOLDER_TOKENS = [
  "change_me",
  "change-me",
  "change me",
  "your_",
  "todo",
  "tbd",
  "example.com",
  "a_remplir",
  "date a renseigner",
  "non renseigne",
];

const normalizeEnvValue = (value) => {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  const lowered = trimmed.toLowerCase();
  if (trimmed === "1970-01-01") return "";
  if (PLACEHOLDER_TOKENS.some((token) => lowered.includes(token))) return "";
  return trimmed;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})/;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_DAYS = 90;

const parseIsoDate = (value) => {
  if (!ISO_DATE_RE.test(value)) return null;
  const [yearStr, monthStr, dayStr] = value.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!year || !month || !day) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return { year, month, day };
};

const readEnvValue = (key, fallback) => {
  const normalized = normalizeEnvValue(process.env[key]);
  return normalized || fallback;
};

const normalizeFacturxSpecVersion = (value) => {
  const normalized = normalizeEnvValue(value);
  if (!normalized) return "";
  if (["1.08", "1.0.8", "1.0.08"].includes(normalized)) return "1.0.8";
  if (["1.07", "1.0.7", "1.0.07"].includes(normalized)) return "1.0.07";
  return normalized;
};

const readFacturxSpecVersion = (key, fallback) => {
  return normalizeFacturxSpecVersion(process.env[key]) || fallback;
};

const readDateEnvValue = (key, fallback) => {
  const normalized = normalizeEnvValue(process.env[key]);
  if (!normalized) return fallback;
  const match = normalized.match(ISO_DATE_PREFIX_RE);
  if (!match) return fallback;
  const parsed = parseIsoDate(match[1]);
  if (!parsed) return fallback;
  return match[1];
};

const parseSourcesLastUpdatedDate = (value) => {
  const normalized = normalizeEnvValue(typeof value === "string" ? value : complianceTimeline.sourcesLastUpdated);
  if (!normalized) return null;
  const match = normalized.match(ISO_DATE_PREFIX_RE);
  if (!match) return null;
  const parsed = parseIsoDate(match[1]);
  if (!parsed) return null;
  if (normalized.length > match[1].length) {
    const parsedTimestamp = Date.parse(normalized);
    if (!Number.isNaN(parsedTimestamp)) {
      return new Date(parsedTimestamp);
    }
  }
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
};

const isSourcesLastUpdatedStale = (maxAgeDays = DEFAULT_STALE_DAYS) => {
  const parsed = parseSourcesLastUpdatedDate();
  if (!parsed) return false;
  const ageMs = Date.now() - parsed.getTime();
  return ageMs > maxAgeDays * MS_PER_DAY;
};

const formatIsoDateShortFr = (value) => {
  const parsed = parseIsoDate(value);
  if (!parsed) return value;
  const day = String(parsed.day).padStart(2, "0");
  const month = String(parsed.month).padStart(2, "0");
  return `${day}/${month}/${parsed.year}`;
};

const formatIsoDateLongFr = (value) => {
  const parsed = parseIsoDate(value);
  if (!parsed) return value;
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  const formatted = new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  if (parsed.day === 1) {
    return formatted.replace(/^1\s/, "1er ");
  }
  return formatted;
};

const getYearFromIsoDate = (value) => {
  const parsed = parseIsoDate(value);
  return parsed ? String(parsed.year) : "";
};

const formatYearRange = (start, end, separator = "-") => {
  const startYear = getYearFromIsoDate(start);
  const endYear = getYearFromIsoDate(end);
  if (!startYear || !endYear) return "";
  if (startYear === endYear) return startYear;
  return `${startYear}${separator}${endYear}`;
};

const rawSourcesLastUpdated = normalizeEnvValue(process.env.NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED);

const DEFAULT_EINVOICING_RECEPTION_DATE = "2026-09-01";
const DEFAULT_EINVOICING_EMISSION_DATE_GE_ETI = "2026-09-01";
const DEFAULT_EINVOICING_EMISSION_DATE_PME = "2027-09-01";
const DEFAULT_FACTURX_SPEC_VERSION = "1.0.8";
const DEFAULT_FACTURX_SPEC_DATE = "2026-01-15";
const DEFAULT_DGFIP_SPEC_VERSION = "B2B v3.2";
const DEFAULT_DGFIP_SPEC_DATE = "2026-04-30";

const complianceTimeline = {
  sourcesLastUpdated: rawSourcesLastUpdated,
  einvoicing: {
    reception: readDateEnvValue("NEXT_PUBLIC_EINVOICING_RECEPTION_DATE", DEFAULT_EINVOICING_RECEPTION_DATE),
    emission_ge_eti: readDateEnvValue(
      "NEXT_PUBLIC_EINVOICING_EMISSION_DATE_GE_ETI",
      DEFAULT_EINVOICING_EMISSION_DATE_GE_ETI,
    ),
    emission_pme_micro: readDateEnvValue(
      "NEXT_PUBLIC_EINVOICING_EMISSION_DATE_PME",
      DEFAULT_EINVOICING_EMISSION_DATE_PME,
    ),
  },
  facturx: {
    version: readFacturxSpecVersion("NEXT_PUBLIC_FACTURX_SPEC_VERSION", DEFAULT_FACTURX_SPEC_VERSION),
    applicableFrom: DEFAULT_FACTURX_SPEC_DATE,
  },
  dgfip: {
    externalSpec: readEnvValue("NEXT_PUBLIC_DGFIP_SPEC_VERSION", DEFAULT_DGFIP_SPEC_VERSION),
    date: readDateEnvValue("NEXT_PUBLIC_DGFIP_SPEC_DATE", DEFAULT_DGFIP_SPEC_DATE),
  },
};

const appEnv = (process.env.APP_ENV || "").trim().toLowerCase();
const isProdLikeEnv = ["prod", "production", "staging"].includes(appEnv);

const sourcesLastUpdatedAvailable = Boolean(complianceTimeline.sourcesLastUpdated);
const sourcesLastUpdatedLabel = complianceTimeline.sourcesLastUpdated || "";
const sourcesLastUpdatedStale = isSourcesLastUpdatedStale();
const showSourcesUpdateBanner = isProdLikeEnv && (!sourcesLastUpdatedAvailable || sourcesLastUpdatedStale);
const sourcesUpdateBannerLabel = !sourcesLastUpdatedAvailable
  ? "Sources officielles non renseignées"
  : sourcesLastUpdatedStale
    ? `Sources officielles possiblement périmées (mise à jour > ${DEFAULT_STALE_DAYS}j)`
    : "";

const TIMELINE_START_DATE = "2023-12-01";
const AVERAGE_MONTH_MS = (365.2425 / 12) * MS_PER_DAY;

const isoDateTimestamp = (value) => {
  const parsed = parseIsoDate(value);
  if (!parsed) return null;
  return Date.UTC(parsed.year, parsed.month - 1, parsed.day);
};

const monthsUntilDate = (targetIsoDate, now = new Date()) => {
  const target = isoDateTimestamp(targetIsoDate);
  const current = now instanceof Date ? now.getTime() : Number.NaN;
  if (target === null || Number.isNaN(current) || target <= current) return 0;
  return Math.max(1, Math.ceil((target - current) / AVERAGE_MONTH_MS));
};

const deadlineBadge = (targetIsoDate, now) => {
  const months = monthsUntilDate(targetIsoDate, now);
  if (months === 0) return "En vigueur";
  if (months === 1) return "< 1 mois";
  return `~${months} mois`;
};

const formatCurrentMonthFr = (now) => {
  const formatted = new Intl.DateTimeFormat("fr-FR", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(now);
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
};

const buildReformTimelineState = (now = new Date()) => {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const nowTimestamp = safeNow.getTime();
  const receptionDate = complianceTimeline.einvoicing.reception;
  const pmeDate = complianceTimeline.einvoicing.emission_pme_micro;
  const receptionLabel = formatIsoDateLongFr(receptionDate);
  const pmeLabel = formatIsoDateLongFr(pmeDate);
  const receptionTimestamp = isoDateTimestamp(receptionDate);
  const pmeTimestamp = isoDateTimestamp(pmeDate);
  const startTimestamp = isoDateTimestamp(TIMELINE_START_DATE);
  const firstDeadlinePassed = receptionTimestamp !== null && nowTimestamp >= receptionTimestamp;
  const secondDeadlinePassed = pmeTimestamp !== null && nowTimestamp >= pmeTimestamp;

  let intro;
  if (!firstDeadlinePassed) {
    const months = monthsUntilDate(receptionDate, safeNow);
    const remaining = months <= 1 ? "moins d’un mois" : `moins de ${months} mois`;
    intro = `Prochaine échéance : le ${receptionLabel} pour la réception généralisée et l’émission des GE/ETI (${remaining}).`;
  } else if (!secondDeadlinePassed) {
    const months = monthsUntilDate(pmeDate, safeNow);
    const remaining = months <= 1 ? "moins d’un mois" : `environ ${months} mois`;
    intro = `La réception généralisée et l’émission des GE/ETI sont en vigueur. Prochaine échéance : le ${pmeLabel} pour les PME et micro-entreprises (${remaining}).`;
  } else {
    intro = "Les échéances générales de réception et d’émission 2026–2027 sont en vigueur.";
  }

  const rawProgress =
    startTimestamp !== null && pmeTimestamp !== null && pmeTimestamp > startTimestamp
      ? ((nowTimestamp - startTimestamp) / (pmeTimestamp - startTimestamp)) * 100
      : 0;

  return {
    nowTimestamp,
    currentDateLabel: formatCurrentMonthFr(safeNow),
    firstDeadlinePassed,
    secondDeadlinePassed,
    firstDeadlineBadge: deadlineBadge(receptionDate, safeNow),
    secondDeadlineBadge: deadlineBadge(pmeDate, safeNow),
    progressPercent: Math.max(0, Math.min(100, Math.round(rawProgress))),
    intro,
  };
};

module.exports = {
  buildReformTimelineState,
  complianceTimeline,
  deadlineBadge,
  formatIsoDateShortFr,
  formatIsoDateLongFr,
  formatYearRange,
  getYearFromIsoDate,
  isProdLikeEnv,
  isSourcesLastUpdatedStale,
  monthsUntilDate,
  parseSourcesLastUpdatedDate,
  showSourcesUpdateBanner,
  sourcesLastUpdatedAvailable,
  sourcesLastUpdatedLabel,
  sourcesLastUpdatedStale,
  sourcesUpdateBannerLabel,
};
