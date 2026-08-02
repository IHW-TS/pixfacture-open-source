import type { Metadata } from "next";

export const APP_NAME = "PixFacture";
export const DEFAULT_DESCRIPTION =
  "SaaS de facturation B2B pour préparer la réforme 2026-2027 selon votre configuration.";
export const DEFAULT_LOCALE = "fr_FR";

const sanitizeBaseUrl = (value?: string): string => {
  const raw = (value || "").trim();
  if (!raw) return "";
  let normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/api")) {
    normalized = normalized.replace(/\/api$/, "");
  }
  if (!/^https?:\/\//i.test(normalized)) return "";
  return normalized;
};

const resolveMetadataBase = (): URL | undefined => {
  const candidates = [
    process.env.NEXT_PUBLIC_APP_BASE_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_API_ORIGIN,
  ];
  for (const candidate of candidates) {
    const sanitized = sanitizeBaseUrl(candidate);
    if (!sanitized) continue;
    try {
      return new URL(sanitized);
    } catch {
      // Ignore invalid values and continue.
    }
  }
  return undefined;
};

const normalizePath = (path: string): string => {
  if (!path || path === "/") return "/";
  return path.startsWith("/") ? path : `/${path}`;
};

export const metadataBase = resolveMetadataBase();
export const siteBaseUrl = metadataBase ? metadataBase.toString().replace(/\/+$/, "") : undefined;

export const toAbsoluteUrl = (path: string): string | undefined => {
  if (!siteBaseUrl) return undefined;
  return `${siteBaseUrl}${normalizePath(path)}`;
};

export const ROOT_METADATA: Metadata = {
  metadataBase,
  title: {
    default: APP_NAME,
    template: `%s | ${APP_NAME}`,
  },
  description: DEFAULT_DESCRIPTION,
  applicationName: APP_NAME,
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
  openGraph: {
    type: "website",
    siteName: APP_NAME,
    locale: DEFAULT_LOCALE,
    title: APP_NAME,
    description: DEFAULT_DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: APP_NAME,
    description: DEFAULT_DESCRIPTION,
  },
};

type MarketingMetadataOptions = {
  title: string;
  description: string;
  path: string;
  canonicalPath?: string;
  index?: boolean;
  follow?: boolean;
};

export const createMarketingMetadata = ({
  title,
  description,
  path,
  canonicalPath,
  index = true,
  follow = true,
}: MarketingMetadataOptions): Metadata => {
  const normalizedPath = normalizePath(path);
  const canonical = normalizePath(canonicalPath || path);
  return {
    title,
    description,
    alternates: {
      canonical,
    },
    openGraph: {
      type: "website",
      siteName: APP_NAME,
      locale: DEFAULT_LOCALE,
      title: `${title} | ${APP_NAME}`,
      description,
      url: normalizedPath,
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | ${APP_NAME}`,
      description,
    },
    robots: {
      index,
      follow,
    },
  };
};
