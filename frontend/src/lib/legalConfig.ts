type ResolvedValue = {
  value: string;
  missing: boolean;
};

export type LegalConfig = {
  companyName: string;
  legalForm: string;
  capital: string;
  rcsCity: string;
  rcsNumber: string;
  vatNumber: string;
  address: string;
  email: string;
  phone: string;
  publisherDirector: string;
  hostingProviderName: string;
  hostingProviderAddress: string;
  hostingProviderPhone: string;
  dpoDesignated: boolean;
  dpoEmail?: string;
  privacyContactEmail: string;
  supportEmail: string;
  legalLastUpdatedISO: string;
};

export type LegalDocSlug = "terms" | "cgv" | "dpa" | "privacy" | "cookies";

const appEnv = (process.env.APP_ENV || "").trim().toLowerCase();
export const isProdLikeEnv = new Set(["prod", "production", "staging"]).has(appEnv);

export const LEGAL_PLACEHOLDER = "À compléter";

const CLIENT_ENV = {
  NEXT_PUBLIC_LEGAL_COMPANY_NAME: process.env.NEXT_PUBLIC_LEGAL_COMPANY_NAME,
  NEXT_PUBLIC_LEGAL_COMPANY_LEGAL_FORM: process.env.NEXT_PUBLIC_LEGAL_COMPANY_LEGAL_FORM,
  NEXT_PUBLIC_LEGAL_COMPANY_CAPITAL: process.env.NEXT_PUBLIC_LEGAL_COMPANY_CAPITAL,
  NEXT_PUBLIC_LEGAL_COMPANY_SHARE_CAPITAL: process.env.NEXT_PUBLIC_LEGAL_COMPANY_SHARE_CAPITAL,
  NEXT_PUBLIC_LEGAL_COMPANY_RCS_CITY: process.env.NEXT_PUBLIC_LEGAL_COMPANY_RCS_CITY,
  NEXT_PUBLIC_LEGAL_COMPANY_RCS_NUMBER: process.env.NEXT_PUBLIC_LEGAL_COMPANY_RCS_NUMBER,
  NEXT_PUBLIC_LEGAL_RCS: process.env.NEXT_PUBLIC_LEGAL_RCS,
  NEXT_PUBLIC_LEGAL_COMPANY_VAT_NUMBER: process.env.NEXT_PUBLIC_LEGAL_COMPANY_VAT_NUMBER,
  NEXT_PUBLIC_LEGAL_VAT_NUMBER: process.env.NEXT_PUBLIC_LEGAL_VAT_NUMBER,
  NEXT_PUBLIC_LEGAL_COMPANY_ADDRESS: process.env.NEXT_PUBLIC_LEGAL_COMPANY_ADDRESS,
  NEXT_PUBLIC_LEGAL_ADDRESS: process.env.NEXT_PUBLIC_LEGAL_ADDRESS,
  NEXT_PUBLIC_LEGAL_COMPANY_EMAIL: process.env.NEXT_PUBLIC_LEGAL_COMPANY_EMAIL,
  NEXT_PUBLIC_LEGAL_EMAIL: process.env.NEXT_PUBLIC_LEGAL_EMAIL,
  NEXT_PUBLIC_LEGAL_COMPANY_PHONE: process.env.NEXT_PUBLIC_LEGAL_COMPANY_PHONE,
  NEXT_PUBLIC_CONTACT_PHONE: process.env.NEXT_PUBLIC_CONTACT_PHONE,
  NEXT_PUBLIC_LEGAL_PUBLISHER_DIRECTOR: process.env.NEXT_PUBLIC_LEGAL_PUBLISHER_DIRECTOR,
  NEXT_PUBLIC_LEGAL_DIRECTOR_PUBLICATION: process.env.NEXT_PUBLIC_LEGAL_DIRECTOR_PUBLICATION,
  NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_NAME: process.env.NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_NAME,
  NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER: process.env.NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER,
  NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_ADDRESS: process.env.NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_ADDRESS,
  NEXT_PUBLIC_LEGAL_HOSTING_PHONE: process.env.NEXT_PUBLIC_LEGAL_HOSTING_PHONE,
  NEXT_PUBLIC_LEGAL_HOSTING_LOCATION: process.env.NEXT_PUBLIC_LEGAL_HOSTING_LOCATION,
  NEXT_PUBLIC_LEGAL_DPO_EMAIL: process.env.NEXT_PUBLIC_LEGAL_DPO_EMAIL,
  NEXT_PUBLIC_DPO_EMAIL: process.env.NEXT_PUBLIC_DPO_EMAIL,
  NEXT_PUBLIC_LEGAL_DPO_DESIGNATED: process.env.NEXT_PUBLIC_LEGAL_DPO_DESIGNATED,
  NEXT_PUBLIC_LEGAL_PRIVACY_CONTACT_EMAIL: process.env.NEXT_PUBLIC_LEGAL_PRIVACY_CONTACT_EMAIL,
  NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL: process.env.NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL,
  NEXT_PUBLIC_LEGAL_LAST_UPDATED: process.env.NEXT_PUBLIC_LEGAL_LAST_UPDATED,
  NEXT_PUBLIC_LEGAL_DOC_VERSION_TERMS: process.env.NEXT_PUBLIC_LEGAL_DOC_VERSION_TERMS,
  NEXT_PUBLIC_LEGAL_DOC_VERSION_CGV: process.env.NEXT_PUBLIC_LEGAL_DOC_VERSION_CGV,
  NEXT_PUBLIC_LEGAL_DOC_VERSION_DPA: process.env.NEXT_PUBLIC_LEGAL_DOC_VERSION_DPA,
  NEXT_PUBLIC_LEGAL_DOC_VERSION_PRIVACY: process.env.NEXT_PUBLIC_LEGAL_DOC_VERSION_PRIVACY,
  NEXT_PUBLIC_LEGAL_DOC_VERSION_COOKIES: process.env.NEXT_PUBLIC_LEGAL_DOC_VERSION_COOKIES,
  NEXT_PUBLIC_LEGAL_JURISDICTION: process.env.NEXT_PUBLIC_LEGAL_JURISDICTION,
  NEXT_PUBLIC_LEGAL_GOVERNING_LAW: process.env.NEXT_PUBLIC_LEGAL_GOVERNING_LAW,
  NEXT_PUBLIC_LEGAL_SUPPORT_HOURS: process.env.NEXT_PUBLIC_LEGAL_SUPPORT_HOURS,
  NEXT_PUBLIC_LEGAL_SUPPORT_TZ: process.env.NEXT_PUBLIC_LEGAL_SUPPORT_TZ,
  NEXT_PUBLIC_LEGAL_SUPPORT_TARGET_CRITICAL: process.env.NEXT_PUBLIC_LEGAL_SUPPORT_TARGET_CRITICAL,
  NEXT_PUBLIC_LEGAL_SUPPORT_TARGET_MAJOR: process.env.NEXT_PUBLIC_LEGAL_SUPPORT_TARGET_MAJOR,
  NEXT_PUBLIC_LEGAL_SUPPORT_TARGET_MINOR: process.env.NEXT_PUBLIC_LEGAL_SUPPORT_TARGET_MINOR,
  NEXT_PUBLIC_LEGAL_SLA_TARGET: process.env.NEXT_PUBLIC_LEGAL_SLA_TARGET,
  NEXT_PUBLIC_LEGAL_SLA_APPLIES_TO: process.env.NEXT_PUBLIC_LEGAL_SLA_APPLIES_TO,
  NEXT_PUBLIC_LEGAL_SLA_MEASUREMENT: process.env.NEXT_PUBLIC_LEGAL_SLA_MEASUREMENT,
  NEXT_PUBLIC_LEGAL_INCIDENT_NOTIFICATION: process.env.NEXT_PUBLIC_LEGAL_INCIDENT_NOTIFICATION,
  NEXT_PUBLIC_LEGAL_RETENTION: process.env.NEXT_PUBLIC_LEGAL_RETENTION,
  NEXT_PUBLIC_LEGAL_EMAIL_PROVIDER: process.env.NEXT_PUBLIC_LEGAL_EMAIL_PROVIDER,
  NEXT_PUBLIC_LEGAL_PAYMENT_PROVIDER: process.env.NEXT_PUBLIC_LEGAL_PAYMENT_PROVIDER,
  NEXT_PUBLIC_LEGAL_MONITORING_PROVIDER: process.env.NEXT_PUBLIC_LEGAL_MONITORING_PROVIDER,
  NEXT_PUBLIC_LEGAL_PDP_PROVIDER: process.env.NEXT_PUBLIC_LEGAL_PDP_PROVIDER,
  NEXT_PUBLIC_LEGAL_PDF_CGV_URL: process.env.NEXT_PUBLIC_LEGAL_PDF_CGV_URL,
  NEXT_PUBLIC_LEGAL_PDF_CGU_URL: process.env.NEXT_PUBLIC_LEGAL_PDF_CGU_URL,
  NEXT_PUBLIC_LEGAL_PDF_DPA_URL: process.env.NEXT_PUBLIC_LEGAL_PDF_DPA_URL,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
} as const;

const resolveEnv = (key: string): string => {
  const value = CLIENT_ENV[key as keyof typeof CLIENT_ENV];
  if (value !== undefined) return value.trim();
  return (process.env[key] || "").trim();
};

const placeholderTokens = [
  "change_me",
  "your_",
  "todo",
  "tbd",
  "example.com",
  "a renseigner",
  "à renseigner",
  "renseigner",
  "a compléter",
  "à compléter",
  "a completer",
  "à completer",
  "metre_ton",
  "mettre_ton",
  "ton_",
  "ta_",
  "a_remplir",
];

export const isLegalValueMissing = (value: string): boolean => {
  const normalized = value.trim();
  if (!normalized) return true;
  if (normalized.includes("<<") || normalized.includes(">>")) return true;
  const lower = normalized.toLowerCase();
  return placeholderTokens.some((token) => lower.includes(token));
};

const resolveEnvValue = (keys: readonly string[], fallback = LEGAL_PLACEHOLDER): ResolvedValue => {
  for (const key of keys) {
    const value = resolveEnv(key);
    if (!isLegalValueMissing(value)) {
      return { value, missing: false };
    }
  }
  return { value: isProdLikeEnv ? "" : fallback, missing: true };
};

export const resolveRequiredLegalEnv = (keys: readonly string[], fallback = LEGAL_PLACEHOLDER): string => {
  return resolveEnvValue(keys, fallback).value;
};

export const resolveOptionalLegalEnv = (keys: readonly string[], fallback?: string): string | undefined => {
  for (const key of keys) {
    const value = resolveEnv(key);
    if (!isLegalValueMissing(value)) {
      return value;
    }
  }
  if (!isProdLikeEnv && fallback) return fallback;
  return undefined;
};

const LEGAL_ENV_KEYS = {
  companyName: ["NEXT_PUBLIC_LEGAL_COMPANY_NAME"],
  legalForm: ["NEXT_PUBLIC_LEGAL_COMPANY_LEGAL_FORM"],
  capital: ["NEXT_PUBLIC_LEGAL_COMPANY_CAPITAL", "NEXT_PUBLIC_LEGAL_COMPANY_SHARE_CAPITAL"],
  rcsCity: ["NEXT_PUBLIC_LEGAL_COMPANY_RCS_CITY"],
  rcsNumber: ["NEXT_PUBLIC_LEGAL_COMPANY_RCS_NUMBER", "NEXT_PUBLIC_LEGAL_RCS"],
  vatNumber: ["NEXT_PUBLIC_LEGAL_COMPANY_VAT_NUMBER", "NEXT_PUBLIC_LEGAL_VAT_NUMBER"],
  address: ["NEXT_PUBLIC_LEGAL_COMPANY_ADDRESS", "NEXT_PUBLIC_LEGAL_ADDRESS"],
  email: ["NEXT_PUBLIC_LEGAL_COMPANY_EMAIL", "NEXT_PUBLIC_LEGAL_EMAIL"],
  phone: ["NEXT_PUBLIC_LEGAL_COMPANY_PHONE", "NEXT_PUBLIC_CONTACT_PHONE"],
  publisherDirector: ["NEXT_PUBLIC_LEGAL_PUBLISHER_DIRECTOR", "NEXT_PUBLIC_LEGAL_DIRECTOR_PUBLICATION"],
  hostingProviderName: ["NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_NAME", "NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER"],
  hostingProviderAddress: ["NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_ADDRESS", "NEXT_PUBLIC_LEGAL_HOSTING_LOCATION"],
  hostingProviderPhone: ["NEXT_PUBLIC_LEGAL_HOSTING_PHONE"],
  dpoEmail: ["NEXT_PUBLIC_LEGAL_DPO_EMAIL", "NEXT_PUBLIC_DPO_EMAIL"],
  privacyContactEmail: [
    "NEXT_PUBLIC_LEGAL_PRIVACY_CONTACT_EMAIL",
    "NEXT_PUBLIC_LEGAL_DPO_EMAIL",
    "NEXT_PUBLIC_DPO_EMAIL",
    "NEXT_PUBLIC_LEGAL_COMPANY_EMAIL",
    "NEXT_PUBLIC_LEGAL_EMAIL",
  ],
  supportEmail: ["NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL", "NEXT_PUBLIC_LEGAL_COMPANY_EMAIL", "NEXT_PUBLIC_LEGAL_EMAIL"],
  legalLastUpdatedISO: ["NEXT_PUBLIC_LEGAL_LAST_UPDATED"],
} as const;

type LegalEnvKey = keyof typeof LEGAL_ENV_KEYS;

const REQUIRED_FIELDS: LegalEnvKey[] = [
  "companyName",
  "legalForm",
  "capital",
  "rcsCity",
  "rcsNumber",
  "vatNumber",
  "address",
  "email",
  "phone",
  "publisherDirector",
  "hostingProviderName",
  "hostingProviderAddress",
  "hostingProviderPhone",
  "privacyContactEmail",
  "supportEmail",
  "legalLastUpdatedISO",
];

const assertRequiredFields = (values: Record<LegalEnvKey, ResolvedValue>) => {
  if (!isProdLikeEnv) return;
  const missingKeys = REQUIRED_FIELDS.filter((field) => values[field].missing).flatMap(
    (field) => LEGAL_ENV_KEYS[field],
  );
  if (missingKeys.length === 0) return;
  const uniqueMissing = Array.from(new Set(missingKeys));
  throw new Error(`Missing legal config env vars: ${uniqueMissing.join(", ")}`);
};

export const getLegalConfig = (): LegalConfig => {
  const companyName = resolveEnvValue(LEGAL_ENV_KEYS.companyName);
  const legalForm = resolveEnvValue(LEGAL_ENV_KEYS.legalForm);
  const capital = resolveEnvValue(LEGAL_ENV_KEYS.capital);
  const rcsCity = resolveEnvValue(LEGAL_ENV_KEYS.rcsCity);
  const rcsNumber = resolveEnvValue(LEGAL_ENV_KEYS.rcsNumber);
  const vatNumber = resolveEnvValue(LEGAL_ENV_KEYS.vatNumber);
  const address = resolveEnvValue(LEGAL_ENV_KEYS.address);
  const email = resolveEnvValue(LEGAL_ENV_KEYS.email);
  const publisherDirector = resolveEnvValue(LEGAL_ENV_KEYS.publisherDirector);
  const hostingProviderName = resolveEnvValue(LEGAL_ENV_KEYS.hostingProviderName);
  const hostingProviderAddress = resolveEnvValue(LEGAL_ENV_KEYS.hostingProviderAddress);
  const hostingProviderPhone = resolveEnvValue(LEGAL_ENV_KEYS.hostingProviderPhone);
  const privacyContactEmail = resolveEnvValue(LEGAL_ENV_KEYS.privacyContactEmail);
  const supportEmail = resolveEnvValue(LEGAL_ENV_KEYS.supportEmail);
  const legalLastUpdatedISO = resolveEnvValue(LEGAL_ENV_KEYS.legalLastUpdatedISO);
  const dpoDesignated = ["1", "true", "yes", "oui"].includes(
    resolveEnv("NEXT_PUBLIC_LEGAL_DPO_DESIGNATED").toLowerCase(),
  );

  const resolved: Record<LegalEnvKey, ResolvedValue> = {
    companyName,
    legalForm,
    capital,
    rcsCity,
    rcsNumber,
    vatNumber,
    address,
    email,
    phone: resolveEnvValue(LEGAL_ENV_KEYS.phone),
    publisherDirector,
    hostingProviderName,
    hostingProviderAddress,
    hostingProviderPhone,
    dpoEmail: resolveEnvValue(LEGAL_ENV_KEYS.dpoEmail),
    privacyContactEmail,
    supportEmail,
    legalLastUpdatedISO,
  };

  assertRequiredFields(resolved);

  return {
    companyName: companyName.value,
    legalForm: legalForm.value,
    capital: capital.value,
    rcsCity: rcsCity.value,
    rcsNumber: rcsNumber.value,
    vatNumber: vatNumber.value,
    address: address.value,
    email: email.value,
    phone: resolved.phone.value,
    publisherDirector: publisherDirector.value,
    hostingProviderName: hostingProviderName.value,
    hostingProviderAddress: hostingProviderAddress.value,
    hostingProviderPhone: hostingProviderPhone.value,
    dpoDesignated,
    dpoEmail: dpoDesignated ? resolveOptionalLegalEnv(LEGAL_ENV_KEYS.dpoEmail) : undefined,
    privacyContactEmail: privacyContactEmail.value,
    supportEmail: supportEmail.value,
    legalLastUpdatedISO: legalLastUpdatedISO.value,
  };
};

const DOC_VERSION_KEYS: Record<LegalDocSlug, readonly string[]> = {
  terms: ["NEXT_PUBLIC_LEGAL_DOC_VERSION_TERMS"],
  cgv: ["NEXT_PUBLIC_LEGAL_DOC_VERSION_CGV", "NEXT_PUBLIC_LEGAL_DOC_VERSION_TERMS"],
  dpa: ["NEXT_PUBLIC_LEGAL_DOC_VERSION_DPA"],
  privacy: ["NEXT_PUBLIC_LEGAL_DOC_VERSION_PRIVACY"],
  cookies: ["NEXT_PUBLIC_LEGAL_DOC_VERSION_COOKIES"],
};

export const getLegalDocVersion = (slug: LegalDocSlug): string => {
  const keys = DOC_VERSION_KEYS[slug];
  return resolveEnvValue(keys).value;
};
