import {
  getLegalConfig,
  getLegalDocVersion,
  resolveOptionalLegalEnv,
  resolveRequiredLegalEnv,
} from "@/lib/legalConfig";
import { SUBPROCESSORS, SUBPROCESSORS_LAST_UPDATED } from "@/lib/subprocessors";

type Subprocessor = {
  name: string;
  purpose: string;
  location?: string;
  safeguards?: string;
  optional?: boolean;
  relationship?: string;
};

type LegalPdfLinks = {
  cgv?: string;
  cgu?: string;
  dpa?: string;
};

const company = getLegalConfig();

const hostingProvider = company.hostingProviderName || "";
const hostingLocation = resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_HOSTING_LOCATION"]);
const hostingLocationLabel = hostingLocation || company.hostingProviderAddress || "";
const hostingLabel = [hostingProvider, hostingLocationLabel].filter(Boolean).join(" — ");

const jurisdiction = resolveRequiredLegalEnv(["NEXT_PUBLIC_LEGAL_JURISDICTION"], "Juridiction du siège social");
const governingLaw = resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_GOVERNING_LAW"], "Droit français") || "Droit français";

const supportHours = resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_SUPPORT_HOURS"], "Horaires communiqués au client");
const supportTimezone = resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_SUPPORT_TZ"], "Europe/Paris");
const supportTargets = {
  critical: resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_SUPPORT_TARGET_CRITICAL"], "Sur demande"),
  major: resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_SUPPORT_TARGET_MAJOR"], "Sur demande"),
  minor: resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_SUPPORT_TARGET_MINOR"], "Sur demande"),
};

const slaAvailabilityTarget = resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_SLA_TARGET"], "Sur demande");
const slaAppliesTo = resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_SLA_APPLIES_TO"], "Sur demande");
const slaMeasurement = resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_SLA_MEASUREMENT"], "Sur demande");

const incidentNotification = resolveOptionalLegalEnv(
  ["NEXT_PUBLIC_LEGAL_INCIDENT_NOTIFICATION"],
  "sans délai indu et, quand possible, sous 72h",
);
const dataRetention = resolveOptionalLegalEnv(
  ["NEXT_PUBLIC_LEGAL_RETENTION"],
  "pièces fiscales et comptables propres à l’abonnement PixFacture selon les obligations de l’Éditeur ; données métier selon le DPA ; journaux applicatifs 12 mois",
);

const rgpdContactLabel = company.dpoEmail ? "DPO" : "Contact RGPD";
const rgpdContactEmail = company.dpoEmail || company.privacyContactEmail;

const emailProvider = resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_EMAIL_PROVIDER"]);
const paymentProvider = resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_PAYMENT_PROVIDER"]);
const sentryEnabled = Boolean((process.env.NEXT_PUBLIC_SENTRY_DSN || "").trim());
const monitoringProvider =
  resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_MONITORING_PROVIDER"]) || (sentryEnabled ? "Sentry" : undefined);
const pdpProvider = resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_PDP_PROVIDER"]);

const reformDisclaimer =
  "Logiciel de facturation : le Service n’est pas une plateforme agréée (PA, ex‑PDP) immatriculée par l’État. " +
  "La transmission réglementaire (e‑invoicing / e‑reporting selon périmètre) exige une plateforme agréée choisie par le Client ou, le cas échéant, un connecteur partenaire sous contrat, mandat et configuration active.";

const isOptionalSubprocessor = (notes?: string) => {
  if (!notes) return false;
  return notes.toLowerCase().includes("optionnel");
};

const subprocessors: Subprocessor[] = SUBPROCESSORS.map((item) => ({
  name: item.name,
  purpose: item.purpose,
  location: item.location,
  safeguards: item.safeguards,
  optional: isOptionalSubprocessor(item.notes),
  relationship: item.relationship,
}));

const pdfLinks: LegalPdfLinks = {
  cgv: resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_PDF_CGV_URL"]),
  cgu: resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_PDF_CGU_URL"]),
  dpa: resolveOptionalLegalEnv(["NEXT_PUBLIC_LEGAL_PDF_DPA_URL"]),
};

export const LEGAL_VARIABLES = {
  company,
  jurisdiction,
  governingLaw,
  reformDisclaimer,
  providers: {
    email: emailProvider,
    payment: paymentProvider,
    monitoring: monitoringProvider,
    pdp: pdpProvider,
  },
  support: {
    hours: supportHours,
    timezone: supportTimezone,
    responseTargets: supportTargets,
  },
  sla: {
    availabilityTarget: slaAvailabilityTarget,
    appliesTo: slaAppliesTo,
    measurement: slaMeasurement,
  },
  hosting: {
    provider: hostingProvider,
    label: hostingLabel,
    location: hostingLocationLabel,
  },
  rgpdContact: {
    label: rgpdContactLabel,
    email: rgpdContactEmail,
  },
  incidentNotification,
  dataRetention,
  subprocessors,
  subprocessorsLastUpdated: SUBPROCESSORS_LAST_UPDATED,
  pdfLinks,
  docVersions: {
    terms: getLegalDocVersion("terms"),
    cgv: getLegalDocVersion("cgv"),
    dpa: getLegalDocVersion("dpa"),
    privacy: getLegalDocVersion("privacy"),
    cookies: getLegalDocVersion("cookies"),
  },
};

export type LegalVariables = typeof LEGAL_VARIABLES;
