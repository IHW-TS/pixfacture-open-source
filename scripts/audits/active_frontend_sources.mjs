#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const appDir = path.join(root, "frontend/src/app");
const compareDir = path.join(root, "frontend/src/figma-compare");
const CHECK_MODE = process.argv.includes("--check");
const CRITICAL_ROUTES = new Set([
  "/pricing",
  "/app/dashboard",
  "/app/billing/paywall",
  "/app/quotes",
  "/app/quotes/:id",
  "/app/quotes/new",
  "/app/invoices",
  "/app/invoices/:id",
  "/app/invoices/new",
  "/app/company",
  "/app/billing",
  "/app/einvoicing",
  "/app/integrations",
  "/app/settings/einvoicing",
  "/app/purchases",
  "/app/purchases/:id",
]);
const NO_LEGACY_COMPARE_SRCS_ROUTES = new Set([
  "/app/dashboard",
  "/app/company",
  "/app/billing",
  "/app/billing/paywall",
  "/app/einvoicing",
  "/app/integrations",
  "/app/settings/einvoicing",
  "/app/purchases",
  "/app/purchases/:id",
]);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name === "page.tsx" ? [full] : [];
  });
}

function routeFromPage(file) {
  const rel = path.relative(appDir, file).replace(/\\/g, "/").replace(/\/page\.tsx$/, "");
  const parts = rel
    .split("/")
    .filter(Boolean)
    .filter((part) => !(part.startsWith("(") && part.endsWith(")")))
    .map((part) => (part.startsWith("[") && part.endsWith("]") ? `:${part.slice(1, -1)}` : part));
  return `/${parts.join("/")}`.replace(/\/$/, "") || "/";
}

function resolveImport(specifier) {
  if (!specifier.startsWith("@figma-compare/")) return null;
  const rel = specifier.replace("@figma-compare/", "");
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    const candidate = path.join(compareDir, `${rel}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  const index = path.join(compareDir, rel, "index.ts");
  return fs.existsSync(index) ? index : null;
}

function requireTargets(file) {
  const content = fs.readFileSync(file, "utf8");
  const targets = [];
  const requireRe = /require\(["']([^"']+)["']\)/g;
  let match;
  while ((match = requireRe.exec(content))) {
    const specifier = match[1];
    if (!specifier.includes("figma-compare-srcs") && !specifier.includes("figma/app")) continue;
    const resolved = path.resolve(path.dirname(file), specifier);
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      const candidate = `${resolved}${ext}`;
      if (fs.existsSync(candidate)) targets.push(candidate);
    }
  }
  return targets;
}

function rel(file) {
  return path.relative(root, file).replace(/\\/g, "/");
}

const rows = walk(appDir)
  .map((page) => {
    const content = fs.readFileSync(page, "utf8");
    const imports = [...content.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    const wrappers = imports.map(resolveImport).filter(Boolean);
    const sourceTargets = wrappers.flatMap(requireTargets);
    return {
      route: routeFromPage(page),
      page: rel(page),
      wrappers: wrappers.map(rel),
      sources: sourceTargets.map(rel),
    };
  })
  .sort((a, b) => a.route.localeCompare(b.route));

if (CHECK_MODE) {
  const missingCriticalRoutes = [...CRITICAL_ROUTES].filter((route) => !rows.some((row) => row.route === route));
  const unresolvedWrappers = rows.filter((row) => CRITICAL_ROUTES.has(row.route) && row.wrappers.length > 0 && row.sources.length === 0);
  const legacyProtectedRoutes = rows.filter(
    (row) =>
      NO_LEGACY_COMPARE_SRCS_ROUTES.has(row.route) &&
      row.sources.some((source) => source.includes("figma-compare-srcs/")),
  );
  if (missingCriticalRoutes.length || unresolvedWrappers.length || legacyProtectedRoutes.length) {
    if (missingCriticalRoutes.length) {
      console.error(`Routes critiques absentes: ${missingCriticalRoutes.join(", ")}`);
    }
    if (unresolvedWrappers.length) {
      console.error("Wrappers critiques sans source finale:");
      for (const row of unresolvedWrappers) {
        console.error(`- ${row.route}: ${row.wrappers.join(", ")}`);
      }
    }
    if (legacyProtectedRoutes.length) {
      console.error("Routes deja migrees qui repassent par figma-compare-srcs:");
      for (const row of legacyProtectedRoutes) {
        console.error(`- ${row.route}: ${row.sources.join(", ")}`);
      }
    }
    process.exit(1);
  }
  console.log(
    `OK active frontend sources: ${rows.length} route(s), ${CRITICAL_ROUTES.size} critique(s) resolue(s), ${NO_LEGACY_COMPARE_SRCS_ROUTES.size} route(s) protegees hors legacy.`,
  );
  process.exit(0);
}

console.log("| Route | Page Next active | Wrapper | Source finale active |");
console.log("| --- | --- | --- | --- |");
for (const row of rows) {
  const wrappers = row.wrappers.length ? row.wrappers.join("<br>") : "-";
  const sources = row.sources.length ? row.sources.join("<br>") : "-";
  console.log(`| \`${row.route}\` | \`${row.page}\` | ${wrappers} | ${sources} |`);
}
