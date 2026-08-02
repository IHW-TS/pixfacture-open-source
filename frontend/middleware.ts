import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isDevPagePath, shouldHideDevPages } from "./src/lib/devPages";

const IS_PROD = process.env.NODE_ENV === "production";
const IS_DEV = process.env.NODE_ENV === "development";
const APP_ENV = (process.env.APP_ENV || "").trim().toLowerCase();
const IS_PROD_LIKE = IS_PROD || new Set(["prod", "production", "staging"]).has(APP_ENV);
const DISABLE_APP_CSP = !IS_PROD_LIKE && process.env.NEXT_PUBLIC_DISABLE_APP_CSP === "true";
const SENSITIVE_PAGE_CACHE_CONTROL = "private, no-store, max-age=0";

const BASE_REQUIRED_FIELDS: { keys: string[]; label: string }[] = [
  { keys: ["NEXT_PUBLIC_LEGAL_COMPANY_NAME"], label: "Nom de la societe" },
  { keys: ["NEXT_PUBLIC_LEGAL_COMPANY_LEGAL_FORM"], label: "Forme legale" },
  { keys: ["NEXT_PUBLIC_LEGAL_COMPANY_CAPITAL", "NEXT_PUBLIC_LEGAL_COMPANY_SHARE_CAPITAL"], label: "Capital social" },
  { keys: ["NEXT_PUBLIC_LEGAL_COMPANY_ADDRESS", "NEXT_PUBLIC_LEGAL_ADDRESS"], label: "Adresse de la societe" },
  { keys: ["NEXT_PUBLIC_LEGAL_COMPANY_EMAIL", "NEXT_PUBLIC_LEGAL_EMAIL"], label: "Email legal" },
  { keys: ["NEXT_PUBLIC_LEGAL_COMPANY_PHONE", "NEXT_PUBLIC_CONTACT_PHONE"], label: "Telephone de la societe" },
  {
    keys: ["NEXT_PUBLIC_LEGAL_PUBLISHER_DIRECTOR", "NEXT_PUBLIC_LEGAL_DIRECTOR_PUBLICATION"],
    label: "Directeur de publication",
  },
  { keys: ["NEXT_PUBLIC_LEGAL_COMPANY_RCS_CITY"], label: "Ville RCS" },
  { keys: ["NEXT_PUBLIC_LEGAL_COMPANY_RCS_NUMBER", "NEXT_PUBLIC_LEGAL_RCS"], label: "Numero RCS" },
  { keys: ["NEXT_PUBLIC_LEGAL_COMPANY_VAT_NUMBER", "NEXT_PUBLIC_LEGAL_VAT_NUMBER"], label: "TVA intracom" },
  {
    keys: ["NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_NAME", "NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER"],
    label: "Hebergeur (nom)",
  },
  {
    keys: ["NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_ADDRESS", "NEXT_PUBLIC_LEGAL_HOSTING_LOCATION"],
    label: "Hebergeur (adresse)",
  },
  { keys: ["NEXT_PUBLIC_LEGAL_HOSTING_PHONE"], label: "Hebergeur (telephone)" },
  {
    keys: [
      "NEXT_PUBLIC_LEGAL_PRIVACY_CONTACT_EMAIL",
      "NEXT_PUBLIC_LEGAL_DPO_EMAIL",
      "NEXT_PUBLIC_DPO_EMAIL",
      "NEXT_PUBLIC_LEGAL_COMPANY_EMAIL",
      "NEXT_PUBLIC_LEGAL_EMAIL",
    ],
    label: "Contact RGPD",
  },
  {
    keys: ["NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL", "NEXT_PUBLIC_LEGAL_COMPANY_EMAIL", "NEXT_PUBLIC_LEGAL_EMAIL"],
    label: "Email support",
  },
  { keys: ["NEXT_PUBLIC_LEGAL_LAST_UPDATED"], label: "Derniere mise a jour" },
  { keys: ["NEXT_PUBLIC_LEGAL_COMPANY_SIRET", "NEXT_PUBLIC_LEGAL_SIRET", "SUPPLIER_SIRET"], label: "SIRET" },
];

const FORBIDDEN_DOMAIN = "example.com";
const PLACEHOLDER_TOKENS = [
  "change_me",
  "your_",
  "todo",
  "tbd",
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

const isMissing = (value: string) => {
  if (!value) return true;
  const normalized = value.toLowerCase();
  if (value.includes("<<") || value.includes(">>")) return true;
  if (normalized.includes(FORBIDDEN_DOMAIN)) return true;
  if (PLACEHOLDER_TOKENS.some((token) => normalized.includes(token))) return true;
  return false;
};

const resolveContactEmail = () => {
  const candidates = [
    process.env.NEXT_PUBLIC_LEGAL_PRIVACY_CONTACT_EMAIL,
    process.env.NEXT_PUBLIC_LEGAL_DPO_EMAIL,
    process.env.NEXT_PUBLIC_DPO_EMAIL,
    process.env.NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL,
    process.env.NEXT_PUBLIC_LEGAL_COMPANY_EMAIL,
    process.env.NEXT_PUBLIC_LEGAL_EMAIL,
  ];
  for (const candidate of candidates) {
    const value = (candidate || "").trim();
    if (!isMissing(value)) return value;
  }
  return "";
};

const missingFields = () => {
  return BASE_REQUIRED_FIELDS.filter((field) => {
    return field.keys.every((key) => isMissing((process.env[key] || "").trim()));
  });
};

const renderMissingPage = (fields: { keys: string[]; label: string }[], nonce: string) => {
  const items = fields.map((field) => `<li>${field.label}</li>`).join("");
  const contactEmail = resolveContactEmail();
  const contactLine = contactEmail
    ? `Contact : <a href="mailto:${contactEmail}">${contactEmail}</a>`
    : "Contact : veuillez joindre l'administrateur du site.";
  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>Maintenance legale</title>
    <style nonce="${nonce}">
      body{font-family:Arial,Helvetica,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:40px;}
      .card{max-width:720px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:24px;box-shadow:0 6px 24px rgba(15,23,42,0.08);}
      h1{margin:0 0 10px;font-size:24px;}
      p{margin:0 0 12px;color:#475569;}
      ul{margin:0;padding-left:18px;color:#475569;}
      .tag{display:inline-block;background:#fee2e2;color:#7f1d1d;border:1px solid #fecaca;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:700;}
      .contact{margin-top:16px;font-weight:600;color:#0f172a;}
    </style>
  </head>
  <body>
    <div class="card">
      <span class="tag">HTTP 503</span>
      <h1>Maintenance legale</h1>
      <p>Le service est temporairement indisponible pendant la mise a jour des informations legales obligatoires.</p>
      <p>Champs manquants :</p>
      <ul>${items}</ul>
      <div class="contact">${contactLine}</div>
    </div>
  </body>
</html>`;
};

const renderDevPageBlocked = (nonce: string) => {
  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>Page indisponible</title>
    <style nonce="${nonce}">
      body{font-family:Arial,Helvetica,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:40px;}
      .card{max-width:720px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:24px;box-shadow:0 6px 24px rgba(15,23,42,0.08);}
      h1{margin:0 0 10px;font-size:24px;}
      p{margin:0 0 12px;color:#475569;}
      .tag{display:inline-block;background:#fee2e2;color:#7f1d1d;border:1px solid #fecaca;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:700;}
    </style>
  </head>
  <body>
    <div class="card">
      <span class="tag">HTTP 404</span>
      <h1>Page introuvable</h1>
      <p>Cette page de démonstration est masquée en production.</p>
    </div>
  </body>
</html>`;
};

const buildNonce = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary);
};

const buildCsp = (nonce: string, frameAncestors: "'none'" | "'self'"): string => {
  const connectSrc = IS_PROD ? "connect-src 'self' https: wss:" : "connect-src 'self' https: http: ws: wss:";
  const scriptSrc = [
    "script-src 'self'",
    `'nonce-${nonce}'`,
    IS_DEV ? "'unsafe-eval'" : "",
    "https://accounts.google.com",
    "https://plausible.io",
  ]
    .filter(Boolean)
    .join(" ");
  // STATIC_NEXT_INLINE_SCRIPTS: statically prerendered App Router pages emit inline
  // RSC bootstrap scripts that cannot receive the per-request middleware nonce.
  const scriptElemSrc = "script-src-elem 'self' 'unsafe-inline' https://accounts.google.com https://plausible.io";
  const styleSrc = "style-src 'self' 'unsafe-inline'";
  return [
    "default-src 'self'",
    scriptSrc,
    scriptElemSrc,
    "script-src-attr 'none'",
    styleSrc,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    connectSrc,
    `frame-ancestors ${frameAncestors}`,
    "frame-src 'self' blob: https://accounts.google.com",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "report-uri /api/security/csp-report",
  ].join("; ");
};

const buildAppCsp = (nonce: string, frameAncestors: "'none'" | "'self'"): string => {
  const connectSrc = IS_PROD ? "connect-src 'self' https: wss:" : "connect-src 'self' https: http: ws: wss:";
  const scriptSrc = [
    "script-src 'self'",
    `'nonce-${nonce}'`,
    IS_DEV ? "'unsafe-eval'" : "",
    "https://accounts.google.com",
    "https://plausible.io",
  ]
    .filter(Boolean)
    .join(" ");
  // STATIC_NEXT_INLINE_SCRIPTS: statically prerendered App Router pages emit inline
  // RSC bootstrap scripts that cannot receive the per-request middleware nonce.
  const scriptElemSrc = "script-src-elem 'self' 'unsafe-inline' https://accounts.google.com https://plausible.io";
  const styleSrc = "style-src 'self' 'unsafe-inline'";
  return [
    "default-src 'self'",
    scriptSrc,
    scriptElemSrc,
    "script-src-attr 'none'",
    styleSrc,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    connectSrc,
    `frame-ancestors ${frameAncestors}`,
    "frame-src 'self' blob: https://accounts.google.com",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "report-uri /api/security/csp-report",
  ].join("; ");
};

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname || "";
  const nonce = buildNonce();
  const isAppPath = pathname.startsWith("/app") || pathname.startsWith("/admin");
  const isPortalEmbeddableDocumentPath =
    /^\/i\/[^/]+\/pdf$/.test(pathname) ||
    /^\/q\/[^/]+\/pdf$/.test(pathname) ||
    /^\/i\/[^/]+\/preview\.html$/.test(pathname) ||
    /^\/q\/[^/]+\/preview\.html$/.test(pathname) ||
    /^\/c\/[^/]+\/(invoices|quotes)\/[^/]+\/pdf$/.test(pathname) ||
    /^\/c\/[^/]+\/(invoices|quotes)\/[^/]+\/preview\.html$/.test(pathname);
  const frameAncestors: "'none'" | "'self'" = isPortalEmbeddableDocumentPath ? "'self'" : "'none'";
  const applyCsp = isAppPath ? !DISABLE_APP_CSP : true;
  const csp = isAppPath ? buildAppCsp(nonce, frameAncestors) : buildCsp(nonce, frameAncestors);
  if (shouldHideDevPages() && isDevPagePath(request.nextUrl.pathname)) {
    const html = renderDevPageBlocked(nonce);
    return new NextResponse(html, {
      status: 404,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
        ...(applyCsp ? { "Content-Security-Policy": csp } : {}),
      },
    });
  }
  if (!IS_PROD_LIKE) {
    return NextResponse.next();
  }
  const fields = missingFields();
  if (fields.length === 0) {
    const requestHeaders = new Headers(request.headers);
    if (applyCsp) {
      requestHeaders.set("x-nonce", nonce);
      requestHeaders.set("Content-Security-Policy", csp);
    }
    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
    if (applyCsp) {
      response.headers.set("Content-Security-Policy", csp);
    }
    if (isAppPath) {
      response.headers.set("Cache-Control", SENSITIVE_PAGE_CACHE_CONTROL);
    }
    return response;
  }
  const html = renderMissingPage(fields, nonce);
  return new NextResponse(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      ...(applyCsp ? { "Content-Security-Policy": csp } : {}),
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|static|api).*)"],
};
