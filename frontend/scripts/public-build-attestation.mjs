#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = resolve(frontendRoot, "src/lib/commercialCatalog.json");
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  if (index === -1) return "";
  if (index + 1 >= args.length) throw new Error(`${name} requiert une valeur.`);
  return args[index + 1];
}

function hasFlag(name) {
  return args.includes(name);
}

function parseEnvFile(content) {
  const values = {};
  const seen = new Set();
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("Ligne invalide dans le fichier frontend env.");
    const key = line.slice(0, separator).trim();
    if (seen.has(key)) throw new Error(`Variable dupliquée dans le fichier frontend env: ${key}.`);
    seen.add(key);
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && ["'", '"'].includes(value[0])) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function normalizeBoolean(value, key) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${key} doit être un booléen public explicite.`);
}

function required(values, key) {
  const value = String(values[key] || "").trim();
  if (!value) throw new Error(`${key} est requis pour l'attestation frontend.`);
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function expectedAttestation(values) {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const claimLevel = required(values, "NEXT_PUBLIC_COMPLIANCE_CLAIM_LEVEL").toLowerCase();
  const termsVersion = required(values, "NEXT_PUBLIC_LEGAL_DOC_VERSION_TERMS");
  const config = {
    compliance: {
      claim_level: claimLevel,
      export_only: claimLevel === "export_only",
      einvoicing_pages_enabled: normalizeBoolean(
        values.NEXT_PUBLIC_ENABLE_EINVOICING_PAGES,
        "NEXT_PUBLIC_ENABLE_EINVOICING_PAGES",
      ),
      pdp_integration_enabled: normalizeBoolean(
        values.NEXT_PUBLIC_ENABLE_PDP_INTEGRATION,
        "NEXT_PUBLIC_ENABLE_PDP_INTEGRATION",
      ),
      ppf_directory_enabled: normalizeBoolean(
        values.NEXT_PUBLIC_ENABLE_PPF_DIRECTORY,
        "NEXT_PUBLIC_ENABLE_PPF_DIRECTORY",
      ),
      commercial_mode_enabled: normalizeBoolean(
        values.NEXT_PUBLIC_MVP_COMMERCIAL_MODE,
        "NEXT_PUBLIC_MVP_COMMERCIAL_MODE",
      ),
    },
    pricing: {
      currency: "EUR",
      unit: "cents_excluding_tax",
      subscription_plans: catalog.subscription_plan_prices_cents,
      token_packs: catalog.token_pack_offers,
    },
    legal_document_versions: {
      terms: termsVersion,
      cgv: String(values.NEXT_PUBLIC_LEGAL_DOC_VERSION_CGV || "").trim() || termsVersion,
      dpa: required(values, "NEXT_PUBLIC_LEGAL_DOC_VERSION_DPA"),
      privacy: required(values, "NEXT_PUBLIC_LEGAL_DOC_VERSION_PRIVACY"),
      cookies: required(values, "NEXT_PUBLIC_LEGAL_DOC_VERSION_COOKIES"),
    },
  };
  return {
    kind: "pixfacture-frontend-public-build-config",
    version: 1,
    config,
    config_sha256: sha256(stableJson(config)),
  };
}

const envFile = option("--env-file");
const outputFile = option("--output");
const verifyFile = option("--verify");
const expectedSha256 = option("--expected-sha256");
const values = envFile ? parseEnvFile(await readFile(resolve(envFile), "utf8")) : process.env;
const expected = await expectedAttestation(values);

if (expectedSha256 && expected.config_sha256 !== expectedSha256) {
  throw new Error("Le hash public attendu ne correspond pas à la configuration réellement compilée.");
}
if (verifyFile) {
  const actual = JSON.parse(await readFile(resolve(verifyFile), "utf8"));
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error("L'attestation frontend extraite ne correspond pas au fichier frontend env et au catalogue.");
  }
}
if (outputFile) {
  const target = resolve(outputFile);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(expected, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
}
if (hasFlag("--print-sha256")) process.stdout.write(`${expected.config_sha256}\n`);
if (!outputFile && !verifyFile && !hasFlag("--print-sha256")) {
  throw new Error("Utiliser --output, --verify ou --print-sha256.");
}
