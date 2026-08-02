export type PaymentPreset = {
  id: string;
  label: string;
  paymentTerms: string;
  days: number;
  endOfMonth?: boolean;
};

export const PAYMENT_PRESETS: PaymentPreset[] = [
  { id: "cash", label: "Comptant", paymentTerms: "Paiement comptant", days: 0 },
  { id: "30", label: "30 jours", paymentTerms: "30 jours date de facture", days: 30 },
  { id: "45eom", label: "45 j fin de mois", paymentTerms: "45 jours fin de mois", days: 45, endOfMonth: true },
  { id: "60", label: "60 jours", paymentTerms: "60 jours date de facture", days: 60 },
];

export const QUOTE_VALIDITY_PRESETS = [
  { id: "7", label: "7 jours", days: 7 },
  { id: "15", label: "15 jours", days: 15 },
  { id: "30", label: "30 jours", days: 30 },
  { id: "45", label: "45 jours", days: 45 },
];

export function digitsOnly(value: string | null | undefined) {
  return String(value || "").replace(/\D+/g, "");
}

export function chunkString(value: string, size: number) {
  return String(value || "").match(new RegExp(`.{1,${size}}`, "g")) || [];
}

export function formatPhoneDisplay(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const compact = raw.replace(/[^\d+]/g, "");
  const digits = digitsOnly(compact);
  if (!digits) return raw;

  if (digits.length === 10 && digits.startsWith("0")) {
    return chunkString(digits, 2).join(" ");
  }

  const frenchInternational = compact.startsWith("+33") && digits.length === 11;
  const frenchInternationalZero = digits.startsWith("0033") && digits.length === 13;
  if (frenchInternational || frenchInternationalZero) {
    const national = frenchInternationalZero ? digits.slice(4) : digits.slice(2);
    return `+33 ${national.slice(0, 1)} ${chunkString(national.slice(1), 2).join(" ")}`.trim();
  }

  if (compact.startsWith("+")) {
    return `+${chunkString(digits, 2).join(" ")}`;
  }

  return chunkString(digits, 2).join(" ");
}

export function luhnIsValid(raw: string | null | undefined) {
  const value = digitsOnly(raw);
  if (!value) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

export function formatSirenInput(value: string | null | undefined) {
  const digits = digitsOnly(value).slice(0, 9);
  return chunkString(digits, 3).join(" ");
}

export function formatSiretInput(value: string | null | undefined) {
  const digits = digitsOnly(value).slice(0, 14);
  const groups = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9), digits.slice(9, 14)].filter(Boolean);
  return groups.join(" ");
}

export function detectFrenchBusinessIdKind(value: string | null | undefined) {
  const digits = digitsOnly(value);
  if (digits.length >= 14) return "siret";
  if (digits.length >= 9) return "siren";
  return "partial";
}

export function formatFrenchBusinessIdInput(value: string | null | undefined) {
  const digits = digitsOnly(value);
  if (digits.length <= 9) return formatSirenInput(digits);
  return formatSiretInput(digits.slice(0, 14));
}

export function formatPostalCodeInput(value: string | null | undefined, countryCode = "FR") {
  const raw = String(value || "");
  if ((countryCode || "FR").toUpperCase() === "FR") {
    return digitsOnly(raw).slice(0, 5);
  }
  return raw.trimStart();
}

const COUNTRY_CODE_ALIASES: Record<string, string> = {
  FR: "FR",
  FRANCE: "FR",
  BE: "BE",
  BELGIQUE: "BE",
  BELGIUM: "BE",
  CH: "CH",
  SUISSE: "CH",
  SWITZERLAND: "CH",
  DE: "DE",
  ALLEMAGNE: "DE",
  GERMANY: "DE",
  LU: "LU",
  LUXEMBOURG: "LU",
};

function countryAliasToken(value: string | null | undefined) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();
}

export function normalizeCountryCode(value: string | null | undefined, fallback: string | null = null) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  return COUNTRY_CODE_ALIASES[countryAliasToken(raw)] || fallback;
}

export function normalizeVatNumber(value: string | null | undefined) {
  return String(value || "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

export function deriveFrenchVatNumberFromSiren(value: string | null | undefined) {
  const siren = digitsOnly(value).slice(0, 9);
  if (siren.length !== 9) return "";
  const key = (12 + 3 * (Number(siren) % 97)) % 97;
  return `FR${String(key).padStart(2, "0")}${siren}`;
}

export function formatVatNumberInput(value: string | null | undefined) {
  const normalized = normalizeVatNumber(value);
  if (!normalized) return "";
  const country = normalized.slice(0, 2);
  const body = normalized.slice(2);
  if (country === "FR") {
    const key = body.slice(0, 2);
    const siren = digitsOnly(body.slice(2)).slice(0, 9);
    if (!key) return country;
    return [country, key, ...chunkString(siren, 3)].filter(Boolean).join(" ");
  }
  return [country, ...chunkString(body, 3)].filter(Boolean).join(" ");
}

export function normalizeNafCode(value: string | null | undefined) {
  const compact = String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(".", "")
    .toUpperCase();
  return compact.slice(0, 5);
}

export function formatNafCodeInput(value: string | null | undefined) {
  const compact = normalizeNafCode(value);
  if (compact.length <= 2) return compact;
  return `${compact.slice(0, 2)}.${compact.slice(2)}`;
}

export function isValidNafCode(value: string | null | undefined) {
  return /^[0-9]{4}[A-Z]$/.test(normalizeNafCode(value));
}

export function normalizeIban(value: string | null | undefined) {
  return String(value || "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

export function formatIbanInput(value: string | null | undefined) {
  return chunkString(normalizeIban(value), 4).join(" ");
}

export function normalizeBic(value: string | null | undefined) {
  return String(value || "")
    .replace(/\s+/g, "")
    .toUpperCase()
    .slice(0, 11);
}

export function formatBicInput(value: string | null | undefined) {
  return normalizeBic(value);
}

export function deriveSirenFromSiret(value: string | null | undefined) {
  const digits = digitsOnly(value);
  return digits.length >= 9 ? digits.slice(0, 9) : "";
}

export function isValidSiren(value: string | null | undefined) {
  const digits = digitsOnly(value);
  return digits.length === 9 && luhnIsValid(digits);
}

export function isValidSiret(value: string | null | undefined) {
  const digits = digitsOnly(value);
  return digits.length === 14 && luhnIsValid(digits);
}

export function isValidFrenchVatNumber(value: string | null | undefined) {
  const normalized = normalizeVatNumber(value);
  return /^FR[0-9A-Z]{2}[0-9]{9}$/.test(normalized);
}

export function isValidIban(value: string | null | undefined) {
  const iban = normalizeIban(value);
  if (!/^[A-Z0-9]+$/.test(iban) || iban.length < 15 || iban.length > 34) return false;
  let remainder = 0;
  for (const ch of `${iban.slice(4)}${iban.slice(0, 4)}`) {
    const converted = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of converted) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

export function isValidBic(value: string | null | undefined) {
  return /^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(normalizeBic(value));
}

export function isoDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(dateString: string | null | undefined, days: number) {
  const base = new Date(dateString || new Date());
  if (Number.isNaN(base.getTime())) return "";
  base.setDate(base.getDate() + Number(days || 0));
  return isoDate(base);
}

export function endOfMonth(dateString: string | null | undefined) {
  const base = new Date(dateString || new Date());
  if (Number.isNaN(base.getTime())) return "";
  return isoDate(new Date(base.getFullYear(), base.getMonth() + 1, 0));
}

export function applyPaymentPreset(docDate: string, presetId: string) {
  const preset = PAYMENT_PRESETS.find((item) => item.id === presetId) || PAYMENT_PRESETS[1];
  let dueDate = addDays(docDate, preset.days);
  if (preset.endOfMonth) {
    dueDate = endOfMonth(dueDate);
  }
  return {
    dueDate,
    paymentTerms: preset.paymentTerms,
    dueDays: diffDays(docDate, dueDate),
    preset,
  };
}

export function diffDays(fromDate: string | null | undefined, toDate: string | null | undefined) {
  if (!fromDate || !toDate) return 0;
  const start = new Date(fromDate);
  const end = new Date(toDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  const delta = end.getTime() - start.getTime();
  return Math.max(0, Math.round(delta / 86400000));
}

export function inferPaymentPreset(paymentTerms: string | null | undefined) {
  const normalized = String(paymentTerms || "")
    .trim()
    .toLowerCase();
  if (!normalized) return PAYMENT_PRESETS[1].id;
  if (normalized.includes("comptant")) return "cash";
  if (normalized.includes("45") && normalized.includes("fin de mois")) return "45eom";
  if (normalized.includes("60")) return "60";
  return "30";
}

export function companyLegalMentionsDefaults(options?: { vatRegime?: string | null; vatOnDebits?: boolean | null }) {
  const vatRegime = String(options?.vatRegime || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const isFranchise = [
    "franchise",
    "franchise_base",
    "franchise_en_base",
    "micro",
    "micro_entreprise",
    "microentreprise",
    "auto_entrepreneur",
    "autoentrepreneur",
  ].includes(vatRegime);
  const vatLine = isFranchise
    ? "TVA non applicable, art. 293 B du CGI."
    : options?.vatOnDebits
      ? "TVA acquittée d'après les débits."
      : "TVA exigible à l'encaissement.";
  return [
    vatLine,
    "Aucun escompte n'est accordé en cas de paiement anticipé.",
    "En cas de retard de paiement, des pénalités au taux de 10 % seront dues à compter du lendemain de l'échéance, ainsi qu'une indemnité forfaitaire de 40 € pour frais de recouvrement.",
  ].join(" ");
}
