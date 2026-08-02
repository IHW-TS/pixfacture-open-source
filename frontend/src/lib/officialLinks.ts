import { complianceTimeline, sourcesLastUpdatedAvailable, sourcesLastUpdatedLabel } from "./complianceTimeline";

export const OFFICIAL_CALENDAR_URL = "https://www.impots.gouv.fr/professionnel/je-passe-la-facturation-electronique";

export const OFFICIAL_B2B_SPECS_URL = "https://www.impots.gouv.fr/specifications-externes-b2b";

export const OFFICIAL_PDP_LIST_URL = "https://www.impots.gouv.fr/je-consulte-la-liste-des-plateformes-agreees";

export const OFFICIAL_PDP_INFO_URL = "https://www.impots.gouv.fr/facturation-electronique-et-plateformes-agreees";

export const OFFICIAL_SOURCES_LAST_UPDATED = complianceTimeline.sourcesLastUpdated;

export const OFFICIAL_SOURCES_LAST_UPDATED_AVAILABLE = sourcesLastUpdatedAvailable;

export const OFFICIAL_SOURCES_LAST_UPDATED_LABEL = sourcesLastUpdatedLabel;

export const OFFICIAL_SOURCES = [
  { label: "Calendrier officiel", url: OFFICIAL_CALENDAR_URL },
  { label: "Spécifications externes B2B (DGFiP)", url: OFFICIAL_B2B_SPECS_URL },
  { label: "Liste officielle des plateformes agréées (PA, ex‑PDP)", url: OFFICIAL_PDP_LIST_URL },
  { label: "Facturation électronique et plateformes agréées", url: OFFICIAL_PDP_INFO_URL },
];
