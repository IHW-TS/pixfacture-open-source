import fs from "node:fs";
import path from "node:path";

const INTERNAL_E2E_API_ORIGIN = "http://backend:8000";
const runtimeOrigin = (process.env.E2E_RUNTIME_API_ORIGIN || "").trim();

const fail = (message) => {
  console.error(`[e2e-runtime] ${message}`);
  process.exit(1);
};

if (runtimeOrigin !== INTERNAL_E2E_API_ORIGIN) {
  fail(`cible API refusée; E2E_RUNTIME_API_ORIGIN doit être exactement ${INTERNAL_E2E_API_ORIGIN}`);
}

const manifestPath = path.resolve(process.cwd(), ".next", "routes-manifest.json");
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`manifeste Next illisible (${error instanceof Error ? error.message : String(error)})`);
}

const rewrites = manifest?.rewrites || {};
const entries = Array.isArray(rewrites)
  ? rewrites
  : [...(rewrites.beforeFiles || []), ...(rewrites.afterFiles || []), ...(rewrites.fallback || [])];
const apiRewrites = entries.filter((entry) => entry?.source === "/api/:path*");

if (apiRewrites.length !== 1) {
  fail(`une unique réécriture /api/:path* est requise (trouvée: ${apiRewrites.length})`);
}

const apiRewrite = apiRewrites[0];
let currentDestination;
try {
  currentDestination = new URL(String(apiRewrite.destination).replace(":path*", "health"));
} catch {
  fail("destination /api/:path* invalide");
}

if (
  currentDestination.username ||
  currentDestination.password ||
  currentDestination.search ||
  currentDestination.hash ||
  currentDestination.pathname !== "/api/health"
) {
  fail("forme de destination /api/:path* inattendue");
}

apiRewrite.destination = `${INTERNAL_E2E_API_ORIGIN}/api/:path*`;

const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
try {
  fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest)}\n`, { mode: 0o644 });
  fs.renameSync(temporaryPath, manifestPath);
} catch (error) {
  try {
    fs.rmSync(temporaryPath, { force: true });
  } catch {
    // Best-effort cleanup after a fail-closed startup error.
  }
  fail(`réécriture du manifeste impossible (${error instanceof Error ? error.message : String(error)})`);
}

console.log("[e2e-runtime] réécriture /api isolée sur le backend Docker jetable");
