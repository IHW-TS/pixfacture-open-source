const DEV_PAGE_PATHS = ["/app/diagnostic", "/app/session-debug"];

const normalizeEnv = (raw?: string | null) => (raw || "").trim().toLowerCase();

const parseEnvBool = (raw?: string | null) => {
  const value = normalizeEnv(raw);
  if (!value) return null;
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  return null;
};

export const shouldHideDevPages = () => {
  const explicit = parseEnvBool(process.env.NEXT_PUBLIC_HIDE_DEV_PAGES);
  if (explicit !== null) return explicit;
  // Safe by default: hide dev pages when env is missing in production builds.
  return process.env.NODE_ENV === "production";
};

export const isDevPagePath = (pathname: string) => {
  return DEV_PAGE_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
};

export { DEV_PAGE_PATHS };
