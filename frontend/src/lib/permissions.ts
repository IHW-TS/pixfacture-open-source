export type PermissionAction =
  | "accounting"
  | "admin"
  | "customers:write"
  | "customers:export"
  | "invoices:write"
  | "invoices:export"
  | "quotes:write"
  | "quotes:convert"
  | "items:write"
  | "team:manage"
  | "integrations:manage";

export type SessionLike =
  | {
      role?: string | null;
      is_admin?: boolean;
    }
  | null
  | undefined;

export type AppRole = "owner" | "admin" | "accountant" | "sales" | "viewer" | "client";

const ACCOUNTING_ROLES = new Set(["owner", "admin", "accountant"]);
const COMMERCIAL_ROLES = new Set(["owner", "admin", "sales"]);
const ADMIN_ROLES = new Set(["owner", "admin"]);

export const ACCOUNTING_TOOLTIP = "réservé aux admins/comptables";
export const ADMIN_TOOLTIP = ACCOUNTING_TOOLTIP;
export const COMMERCIAL_TOOLTIP = "réservé aux admins/commerciaux";

export function can(session: SessionLike, action: PermissionAction): boolean {
  const role = (session?.role || "").toLowerCase();
  const isPlatformAdmin = session?.is_admin === true;
  const isAccounting = isPlatformAdmin || ACCOUNTING_ROLES.has(role);
  const isCommercial = isPlatformAdmin || COMMERCIAL_ROLES.has(role);
  const isTenantAdmin = isPlatformAdmin || ADMIN_ROLES.has(role);

  switch (action) {
    case "admin":
    case "team:manage":
    case "integrations:manage":
      return isTenantAdmin;
    case "accounting":
    case "invoices:write":
    case "invoices:export":
    case "quotes:convert":
      return isAccounting;
    case "quotes:write":
    case "customers:write":
    case "items:write":
      return isCommercial;
    case "customers:export":
      // Export clients est volontairement plus restrictif (données perso, CSV massif)
      // -> aligné sur le backend (admin/comptable uniquement).
      return isAccounting;
    default:
      return false;
  }
}

const pathMatches = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

const pathMatchesAny = (pathname: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => pathMatches(pathname, prefix));

const COMMON_APP_PATHS = ["/app/account", "/app/logout", "/app/password-reset", "/app/settings/security"] as const;

const CLIENT_APP_PATHS = ["/app/portal", "/app/client-invoices", ...COMMON_APP_PATHS] as const;

const PLATFORM_ADMIN_PATHS = ["/app/admin"] as const;

const TENANT_ADMIN_PATHS = [
  "/app/audit",
  "/app/automations",
  "/app/b2b-einvoicing",
  "/app/billing",
  "/app/campaigns",
  "/app/company",
  "/app/directory",
  "/app/einvoicing",
  "/app/integrations",
  "/app/outbox",
  "/app/scheduler",
  "/app/setup/einvoicing",
  "/app/settings/attachments",
  "/app/settings/billing",
  "/app/settings/branding",
  "/app/settings/company",
  "/app/settings/dunning",
  "/app/settings/einvoicing",
  "/app/settings/migration",
  "/app/settings/platforms",
  "/app/settings/portals",
  "/app/settings/sandbox",
  "/app/users",
] as const;

const ACCOUNTING_PATHS = [
  "/app/cash",
  "/app/conformite",
  "/app/e-reporting",
  "/app/inbox",
  "/app/payments",
  "/app/purchases",
  "/app/receivables",
  "/app/sales/payments",
  "/app/settings/export",
  "/app/team",
  "/app/transmissions",
] as const;

const SALES_READ_PATHS = [
  "/app/customers",
  "/app/dashboard",
  "/app/get-started",
  "/app/invoices",
  "/app/items",
  "/app/notifications",
  "/app/portfolio",
  "/app/quotes",
  "/app/sales/invoices",
  "/app/sales/quotes",
  "/app/tasks",
] as const;

const VIEWER_READ_PATHS = [
  ...SALES_READ_PATHS,
  "/app/cash",
  "/app/inbox",
  "/app/payments",
  "/app/purchases",
  "/app/receivables",
  "/app/recurring",
] as const;

export function normalizeAppRole(session: SessionLike): AppRole | null {
  const role = String(session?.role || "")
    .trim()
    .toLowerCase();
  if (["owner", "admin", "accountant", "sales", "viewer", "client"].includes(role)) {
    return role as AppRole;
  }
  return null;
}

export function defaultAppPath(session: SessionLike): string {
  return normalizeAppRole(session) === "client" ? "/app/portal" : "/app/dashboard";
}

/**
 * UI route policy. The API remains authoritative, but applying the same least-
 * privilege model before rendering prevents forbidden pages and their effects
 * from mounting while a client-side redirect is still pending.
 */
export function canAccessAppPath(session: SessionLike, rawPathname: string): boolean {
  const pathname = String(rawPathname || "/app/dashboard").split(/[?#]/, 1)[0] || "/app/dashboard";
  const role = normalizeAppRole(session);
  const isPlatformAdmin = session?.is_admin === true;

  if (pathMatchesAny(pathname, PLATFORM_ADMIN_PATHS)) return isPlatformAdmin;
  if (isPlatformAdmin) return true;
  if (pathname === "/app") return role !== "client";
  if (!role) return pathMatchesAny(pathname, COMMON_APP_PATHS) || pathname === "/app/dashboard";
  if (role === "client") return pathMatchesAny(pathname, CLIENT_APP_PATHS);
  if (pathMatchesAny(pathname, COMMON_APP_PATHS)) return true;
  if (role === "owner" || role === "admin") return true;
  if (pathMatchesAny(pathname, TENANT_ADMIN_PATHS)) return false;

  if (pathMatches(pathname, "/app/invoices/new")) return can(session, "invoices:write");
  if (pathMatches(pathname, "/app/quotes/new")) return can(session, "quotes:write");
  if (pathMatches(pathname, "/app/customers/new")) return can(session, "customers:write");
  if (pathMatches(pathname, "/app/new")) {
    return can(session, "invoices:write") || can(session, "quotes:write");
  }

  if (role === "accountant") {
    return pathMatchesAny(pathname, [...VIEWER_READ_PATHS, ...ACCOUNTING_PATHS]);
  }
  if (role === "sales") return pathMatchesAny(pathname, SALES_READ_PATHS);
  if (role === "viewer") return pathMatchesAny(pathname, VIEWER_READ_PATHS);
  return false;
}
