import { canAccessAppPath, normalizeAppRole, type SessionLike } from "./permissions";

export type AppNavigationBadgeKey = "invoicesTotal" | "inboxTotal";

export type AppNavigationIconKey =
  | "dashboard"
  | "customers"
  | "quotes"
  | "invoices"
  | "purchases"
  | "cash"
  | "items"
  | "settings"
  | "help"
  | "company"
  | "team"
  | "billing"
  | "branding"
  | "migration"
  | "portals"
  | "dunning"
  | "webhooks"
  | "admin"
  | "create"
  | "einvoicing"
  | "transmissions"
  | "integrations"
  | "exports"
  | "tasks"
  | "alerts"
  | "automation"
  | "campaigns"
  | "outbox"
  | "scheduler"
  | "portfolio"
  | "payments"
  | "receivables"
  | "recurring";

export type AppNavigationItem = {
  id: string;
  label: string;
  href: string;
  icon: AppNavigationIconKey;
  accent: string;
  badgeKey?: AppNavigationBadgeKey;
  match?: string[];
};

export type AppNavigationModule = AppNavigationItem;
export type AppNavigationChild = AppNavigationItem;

export type AppMobileDockItem = {
  id: string;
  label: string;
  href: string;
  icon: AppNavigationIconKey;
  primary?: boolean;
  match?: string[];
};

const parsePublicFlag = (raw: string | undefined, fallback = false) => {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (!value) return fallback;
  if (["true", "1", "yes", "y", "on"].includes(value)) return true;
  if (["false", "0", "no", "n", "off"].includes(value)) return false;
  return fallback;
};

export const ADVANCED_NAVIGATION_FLAG = "NEXT_PUBLIC_PIXFACTURE_SHOW_ADVANCED_NAV";

const PRO_ONLY_NAVIGATION_IDS = new Set(["purchases", "cash", "einvoicing"]);

export function canAccessNavigationItemForPlan(itemId: string, plan?: string | null) {
  if (!PRO_ONLY_NAVIGATION_IDS.has(itemId)) return true;
  const normalized = String(plan || "")
    .trim()
    .toLowerCase();
  return normalized === "pro" || normalized === "enterprise";
}

export function shouldShowAdvancedNavigation() {
  return parsePublicFlag(process.env.NEXT_PUBLIC_PIXFACTURE_SHOW_ADVANCED_NAV, false);
}

export const APP_NAVIGATION_MODULES: AppNavigationModule[] = [
  {
    id: "dashboard",
    label: "Tableau de bord",
    href: "/app/dashboard",
    icon: "dashboard",
    accent: "#60a5fa",
  },
  {
    id: "invoices",
    label: "Factures",
    href: "/app/invoices",
    icon: "invoices",
    accent: "#3b82f6",
    badgeKey: "invoicesTotal",
    match: ["/app/recurring"],
  },
  {
    id: "quotes",
    label: "Devis",
    href: "/app/quotes",
    icon: "quotes",
    accent: "#8b5cf6",
  },
  {
    id: "customers",
    label: "Clients",
    href: "/app/customers",
    icon: "customers",
    accent: "#10b981",
    match: ["/app/portfolio"],
  },
  {
    id: "purchases",
    label: "Achats",
    href: "/app/purchases",
    icon: "purchases",
    accent: "#f59e0b",
    badgeKey: "inboxTotal",
    match: ["/app/inbox"],
  },
  {
    id: "cash",
    label: "Paiements",
    href: "/app/cash",
    icon: "cash",
    accent: "#10b981",
    match: ["/app/payments"],
  },
  {
    id: "einvoicing",
    label: "E-facturation",
    href: "/app/einvoicing",
    icon: "einvoicing",
    accent: "#2563eb",
    match: [
      "/app/b2b-einvoicing",
      "/app/conformite",
      "/app/directory",
      "/app/e-reporting",
      "/app/integrations",
      "/app/pdp",
      "/app/setup/einvoicing",
      "/app/settings/einvoicing",
      "/app/settings/platforms",
      "/app/transmissions",
    ],
  },
];

export const APP_PROFILE_NAVIGATION_ITEMS: AppNavigationItem[] = [
  {
    id: "company",
    label: "Mon entreprise",
    href: "/app/company",
    icon: "company",
    accent: "#0f172a",
  },
  {
    id: "team",
    label: "Équipe & comptable",
    href: "/app/team",
    icon: "team",
    accent: "#0f172a",
  },
  {
    id: "billing",
    label: "Abonnement",
    href: "/app/billing",
    icon: "billing",
    accent: "#16a34a",
  },
];

export const APP_ADVANCED_PROFILE_ITEMS: AppNavigationItem[] = [
  { id: "tasks", label: "Tâches", href: "/app/tasks", icon: "tasks", accent: "#64748b" },
  { id: "alerts", label: "Alertes", href: "/app/notifications", icon: "alerts", accent: "#ef4444" },
  { id: "automation", label: "Automatisation", href: "/app/automations", icon: "automation", accent: "#7c3aed" },
  { id: "campaigns", label: "Campagnes", href: "/app/campaigns", icon: "campaigns", accent: "#db2777" },
  { id: "outbox", label: "Envois", href: "/app/outbox", icon: "outbox", accent: "#475569" },
  { id: "scheduler", label: "Planification", href: "/app/scheduler", icon: "scheduler", accent: "#475569" },
];

export const APP_ADMIN_NAVIGATION_ITEMS: AppNavigationItem[] = [
  { id: "admin-home", label: "Administration", href: "/app/admin", icon: "admin", accent: "#0f172a" },
  { id: "admin-tenants", label: "Espaces", href: "/app/admin/tenants", icon: "admin", accent: "#0f172a" },
  { id: "admin-readiness", label: "Préparation", href: "/app/admin/readiness", icon: "admin", accent: "#0f172a" },
  { id: "admin-deployment", label: "Déploiement", href: "/app/admin/deployment", icon: "admin", accent: "#0f172a" },
  { id: "admin-legal-pack", label: "Dossier légal", href: "/app/admin/legal-pack", icon: "admin", accent: "#0f172a" },
  {
    id: "admin-usage-pdp",
    label: "Usage plateforme partenaire",
    href: "/app/admin/usage-pdp",
    icon: "admin",
    accent: "#0f172a",
  },
  {
    id: "admin-diagnostic",
    label: "Contrôles support",
    href: "/app/admin/diagnostic",
    icon: "admin",
    accent: "#0f172a",
  },
];

export const APP_HIDDEN_NAVIGATION_ITEMS: AppNavigationItem[] = [
  { id: "payments", label: "Paiements", href: "/app/cash", icon: "cash", accent: "#14b8a6" },
  { id: "recurring", label: "Récurrence", href: "/app/recurring", icon: "recurring", accent: "#8b5cf6" },
  { id: "portfolio", label: "Portefeuille client", href: "/app/portfolio", icon: "portfolio", accent: "#10b981" },
  ...APP_ADVANCED_PROFILE_ITEMS,
];

export const APP_CLIENT_NAVIGATION_ITEMS: AppNavigationModule[] = [
  {
    id: "client-portal",
    label: "Mes documents",
    href: "/app/portal",
    icon: "invoices",
    accent: "#3b82f6",
    match: ["/app/client-invoices"],
  },
];

export const APP_MOBILE_DOCK_ITEMS: AppMobileDockItem[] = [
  { id: "dashboard", label: "Accueil", href: "/app/dashboard", icon: "dashboard", match: ["/app/dashboard"] },
  { id: "invoices", label: "Factures", href: "/app/invoices", icon: "invoices", match: ["/app/invoices"] },
  { id: "create", label: "Créer", href: "/app/new", icon: "create", primary: true, match: ["/app/new"] },
  {
    id: "customers",
    label: "Clients",
    href: "/app/customers",
    icon: "customers",
    match: ["/app/customers", "/app/portfolio"],
  },
  {
    id: "purchases",
    label: "Achats",
    href: "/app/purchases",
    icon: "purchases",
    match: ["/app/purchases", "/app/inbox"],
  },
];

export const APP_ROUTE_LABELS: Record<string, string> = {
  dashboard: "Tableau de bord",
  customers: "Clients",
  new: "Nouveau",
  invoices: "Factures",
  sales: "Factures",
  quotes: "Devis",
  payments: "Paiements",
  purchases: "Achats",
  inbox: "Factures reçues",
  cash: "Paiements",
  settings: "Réglages",
  admin: "Administration",
  portfolio: "Portefeuille",
  recurring: "Récurrence",
  receivables: "Factures en retard",
  tasks: "Tâches",
  notifications: "Alertes",
  automations: "Automatisation",
  campaigns: "Campagnes",
  outbox: "Envois",
  scheduler: "Planification",
  einvoicing: "E-facturation",
  "b2b-einvoicing": "E-facturation",
  transmissions: "Transmissions",
  integrations: "Intégrations",
  conformite: "Conformité",
  "e-reporting": "E-reporting",
  directory: "Annuaire",
  company: "Entreprise",
  billing: "Abonnement",
  items: "Produits & services",
  team: "Équipe",
  account: "Mon compte",
  audit: "Journal",
  "get-started": "Entreprise",
  help: "Démarrage",
  onboarding: "Entreprise",
  branding: "Branding",
  security: "Sécurité",
  export: "Dossier comptable",
  migration: "Imports CSV",
  platforms: "Plateformes",
  attachments: "Pièces jointes",
  portals: "Portails",
  dunning: "Factures en retard",
  webhooks: "Automatisations externes",
  sandbox: "Espace de test",
  readiness: "Préparation",
  deployment: "Déploiement",
  tenants: "Espaces",
  "legal-pack": "Dossier légal",
  "usage-pdp": "Usage plateforme partenaire",
  "usage-seqino": "Usage plateforme partenaire",
  diagnostic: "Contrôles support",
  "session-debug": "Diagnostic session",
  portal: "Portail",
  pdp: "Transmissions",
  setup: "Configuration",
  paywall: "Abonnement requis",
};

export function getAppNavigationModules(session?: SessionLike, plan?: string | null): AppNavigationModule[] {
  if (session && normalizeAppRole(session) === "client") return APP_CLIENT_NAVIGATION_ITEMS;
  return APP_NAVIGATION_MODULES.filter(
    (item) => (!session || canAccessAppPath(session, item.href)) && canAccessNavigationItemForPlan(item.id, plan),
  );
}

export function getProfileNavigationItems(options: { canSeeAdmin?: boolean; session?: SessionLike } = {}) {
  const advanced = shouldShowAdvancedNavigation() ? APP_ADVANCED_PROFILE_ITEMS : [];
  const admin = options.canSeeAdmin ? APP_ADMIN_NAVIGATION_ITEMS : [];
  return [...APP_PROFILE_NAVIGATION_ITEMS, ...advanced, ...admin].filter(
    (item) => !options.session || canAccessAppPath(options.session, item.href),
  );
}

export function isAppPathActive(pathname: string, href: string, match: string[] = []) {
  if (pathname === href || pathname.startsWith(`${href}/`)) return true;
  return match.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function isAppModuleActive(pathname: string, module: AppNavigationModule) {
  return isAppPathActive(pathname, module.href, module.match);
}

export function getAppRouteLabel(segment: string) {
  return APP_ROUTE_LABELS[segment] ?? segment.charAt(0).toUpperCase() + segment.slice(1);
}
