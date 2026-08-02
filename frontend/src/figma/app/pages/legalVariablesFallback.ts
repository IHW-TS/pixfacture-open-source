import type { LegalVariables } from "@/app/(marketing)/legal/variables";

export type LegalPageProps = {
  legalVariables?: LegalVariables;
};

export const FALLBACK_LEGAL_VARIABLES: LegalVariables = {
  company: {
    companyName: "PixFacture",
    legalForm: "SaaS",
    capital: "",
    rcsCity: "",
    rcsNumber: "",
    vatNumber: "",
    address: "France",
    email: "contact@pixfacture.fr",
    phone: "+33 1 00 00 00 00",
    publisherDirector: "Direction de PixFacture",
    hostingProviderName: "Hébergement UE/EEE",
    hostingProviderAddress: "Union européenne",
    hostingProviderPhone: "+33 1 00 00 00 00",
    dpoDesignated: false,
    privacyContactEmail: "privacy@pixfacture.fr",
    supportEmail: "support@pixfacture.fr",
    legalLastUpdatedISO: "2026-07-11",
  },
  jurisdiction: "Droit français",
  governingLaw: "Droit français",
  reformDisclaimer:
    "Logiciel de facturation : le Service n’est pas une plateforme agréée (PA, ex‑PDP) immatriculée par l’État. " +
    "La transmission réglementaire exige une plateforme agréée choisie par le Client ou un connecteur partenaire sous contrat, mandat et configuration opérationnelle.",
  providers: {
    email: undefined,
    payment: undefined,
    monitoring: undefined,
    pdp: undefined,
  },
  support: {
    hours: "Horaires communiqués au client",
    timezone: "Europe/Paris",
    responseTargets: {
      critical: "Sur demande",
      major: "Sur demande",
      minor: "Sur demande",
    },
  },
  sla: {
    availabilityTarget: "Sur demande",
    appliesTo: "Sur demande",
    measurement: "Sur demande",
  },
  hosting: {
    provider: "Hébergement UE/EEE",
    label: "Hébergement UE/EEE — Union européenne",
    location: "Union européenne",
  },
  rgpdContact: {
    label: "Contact RGPD",
    email: "privacy@pixfacture.fr",
  },
  incidentNotification: "sans délai indu et, quand possible, sous 72h",
  dataRetention:
    "pièces fiscales et comptables propres à l’abonnement PixFacture selon les obligations de l’Éditeur ; données métier selon le DPA ; journaux applicatifs 12 mois",
  subprocessors: [],
  subprocessorsLastUpdated: "2026-07-11",
  pdfLinks: {},
  docVersions: {
    terms: "2026-07-11",
    cgv: "2026-07-11",
    dpa: "2026-07-11",
    privacy: "2026-07-11",
    cookies: "2026-07-11",
  },
};
