export const PUBLIC_APP_SESSION_ROUTES = [
  "/app/login",
  "/app/register",
  "/app/password-reset",
  "/app/verify-email",
  "/app/invite",
  "/app/invites/accept",
] as const;

const pathMatches = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export const isPublicAppSessionPath = (rawPathname: string) => {
  const pathname = String(rawPathname || "").split(/[?#]/, 1)[0];
  return PUBLIC_APP_SESSION_ROUTES.some((route) => pathMatches(pathname, route));
};

export const shouldRedirectExpiredSession = (rawPathname: string) => {
  const pathname = String(rawPathname || "").split(/[?#]/, 1)[0];
  const isProtectedApp = pathMatches(pathname, "/app") && !isPublicAppSessionPath(pathname);
  const isAdmin = pathMatches(pathname, "/admin");
  return isProtectedApp || isAdmin;
};
