type DateInput = Date | string | number | null | undefined;

const BUSINESS_TIME_ZONE = "Europe/Paris";

const DATE_FORMATTER = new Intl.DateTimeFormat("fr-FR", {
  timeZone: BUSINESS_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("fr-FR", {
  timeZone: BUSINESS_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const MONTH_YEAR_FORMATTER = new Intl.DateTimeFormat("fr-FR", {
  timeZone: BUSINESS_TIME_ZONE,
  month: "long",
  year: "numeric",
});

const normalizeDateInput = (value: string) => {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    return `${trimmed}Z`;
  }
  return trimmed;
};

const parseDate = (value: DateInput) => {
  if (!value) return null;
  const source = typeof value === "string" ? normalizeDateInput(value) : value;
  const date = source instanceof Date ? source : new Date(source);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

const parseMonth = (value: DateInput) => {
  if (!value) return null;
  if (value instanceof Date) {
    return new Date(value.getFullYear(), value.getMonth(), 1);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const match = /^(\d{4})-(\d{2})/.exec(trimmed);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      if (year && month >= 1 && month <= 12) {
        return new Date(year, month - 1, 1);
      }
    }
  }
  const date = parseDate(value);
  if (!date) return null;
  return new Date(date.getFullYear(), date.getMonth(), 1);
};

export const formatDateFr = (value: DateInput, fallback = "-") => {
  const date = parseDate(value);
  return date ? DATE_FORMATTER.format(date) : fallback;
};

export const formatDateTimeFr = (value: DateInput, fallback = "-") => {
  const date = parseDate(value);
  return date ? DATE_TIME_FORMATTER.format(date) : fallback;
};

export const formatMonthYearFr = (value: DateInput, fallback = "-") => {
  const date = parseMonth(value);
  return date ? MONTH_YEAR_FORMATTER.format(date) : fallback;
};
