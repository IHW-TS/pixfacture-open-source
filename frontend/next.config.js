const path = require("path");

const isProd = process.env.NODE_ENV === "production";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  experimental: {
    externalDir: true,
  },
  images: {
    unoptimized: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },

  async headers() {
    const baseSecurityHeaders = [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ];
    const commonHeaders = [{ key: "X-Frame-Options", value: "DENY" }, ...baseSecurityHeaders];
    const embeddablePreviewHeaders = [
      ...baseSecurityHeaders,
      { key: "Content-Security-Policy", value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" },
    ];
    const prodHeaders = isProd
      ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
      : [];
    return [
      {
        source: "/legal/:path*",
        headers: [
          ...commonHeaders,
          ...prodHeaders,
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/app/:path*",
        headers: [
          ...commonHeaders,
          ...prodHeaders,
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
        ],
      },
      {
        source: "/admin/:path*",
        headers: [
          ...commonHeaders,
          ...prodHeaders,
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
        ],
      },
      {
        source: "/i/:token/preview.html",
        headers: [...embeddablePreviewHeaders, ...prodHeaders],
      },
      {
        source: "/q/:token/preview.html",
        headers: [...embeddablePreviewHeaders, ...prodHeaders],
      },
      {
        source: "/c/:token/invoices/:invoiceId/preview.html",
        headers: [...embeddablePreviewHeaders, ...prodHeaders],
      },
      {
        source: "/c/:token/quotes/:quoteId/preview.html",
        headers: [...embeddablePreviewHeaders, ...prodHeaders],
      },
      {
        source:
          "/((?!api|legal(?:/|$)|app(?:/|$)|admin(?:/|$)|i/[^/]+/preview\\.html|q/[^/]+/preview\\.html|c/[^/]+/(?:invoices|quotes)/[^/]+/preview\\.html).*)",
        headers: [...commonHeaders, ...prodHeaders],
      },
    ];
  },

  async rewrites() {
    const apiOrigin = process.env.API_ORIGIN || process.env.NEXT_PUBLIC_API_ORIGIN || "http://localhost:8000";
    const normalizedOrigin = apiOrigin.replace(/\/$/, "");
    return [
      {
        source: "/api/:path*",
        destination: `${normalizedOrigin}/api/:path*`,
      },
    ];
  },

  webpack(config) {
    // Alias "@" => dossier "src"
    config.resolve.alias["@"] = path.resolve(__dirname, "src");
    config.resolve.alias["@figma-compare"] = path.resolve(__dirname, "src", "figma-compare");
    config.resolve.alias["react-router"] = path.resolve(__dirname, "src", "figma", "react-router-compat.tsx");
    return config;
  },
};

module.exports = nextConfig;
