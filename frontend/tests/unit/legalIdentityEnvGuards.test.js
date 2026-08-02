const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const frontendRoot = path.join(__dirname, "../..");
const checker = path.join(frontendRoot, "scripts/check-legal-env.mjs");

const validLegalEnv = {
  ...process.env,
  APP_ENV: "prod",
  NODE_ENV: "production",
  NEXT_PUBLIC_APP_BASE_URL: "https://app.pixfacture.fr",
  NEXT_PUBLIC_LEGAL_COMPANY_NAME: "ENTREPRISE EXEMPLE",
  NEXT_PUBLIC_LEGAL_COMPANY_LEGAL_FORM: "SARL",
  NEXT_PUBLIC_LEGAL_COMPANY_CAPITAL: "8 000 EUR",
  NEXT_PUBLIC_LEGAL_COMPANY_ADDRESS: "1 rue Exemple, 75000 Paris",
  NEXT_PUBLIC_LEGAL_COMPANY_EMAIL: "contact@example.test",
  NEXT_PUBLIC_LEGAL_COMPANY_PHONE: "+33102030405",
  NEXT_PUBLIC_LEGAL_PUBLISHER_DIRECTOR: "Camille MARTIN",
  NEXT_PUBLIC_LEGAL_COMPANY_RCS_CITY: "Evry",
  NEXT_PUBLIC_LEGAL_COMPANY_RCS_NUMBER: "000 000 000",
  NEXT_PUBLIC_LEGAL_COMPANY_VAT_NUMBER: "FR00000000000",
  NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_NAME: "OVHcloud",
  NEXT_PUBLIC_LEGAL_HOSTING_PROVIDER_ADDRESS: "2 rue Kellermann, 59100 Roubaix",
  NEXT_PUBLIC_LEGAL_HOSTING_PHONE: "+33 9 72 10 10 07",
  NEXT_PUBLIC_LEGAL_PRIVACY_CONTACT_EMAIL: "contact@example.test",
  NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL: "contact@example.test",
  NEXT_PUBLIC_LEGAL_LAST_UPDATED: "2026-07-11",
  NEXT_PUBLIC_SOURCE_CODE_URL: "https://github.com/IHW-TS/pixfacture-open-source",
  NEXT_PUBLIC_LEGAL_COMPANY_SIRET: "00000000000000",
  NEXT_PUBLIC_OFFICIAL_SOURCES_LAST_UPDATED: "2026-07-11",
  NEXT_PUBLIC_TRUST_CENTER_LAST_UPDATED: "2026-07-11",
  LEGAL_TERMS_ACCEPTANCE_REQUIRED: "false",
  LEGAL_DPA_ACCEPTANCE_REQUIRED: "false",
  NEXT_PUBLIC_LEGAL_DPO_DESIGNATED: "false",
};

const runChecker = (overrides = {}, removedKeys = []) => {
  const env = { ...validLegalEnv, ...overrides };
  for (const key of removedKeys) delete env[key];
  return spawnSync(process.execPath, [checker], {
    cwd: frontendRoot,
    env,
    encoding: "utf8",
  });
};

test("le contrôle juridique accepte une identité complète", () => {
  const result = runChecker();
  assert.equal(result.status, 0, result.stderr);
});

test("le contrôle juridique refuse un capital social absent", () => {
  const result = runChecker({}, ["NEXT_PUBLIC_LEGAL_COMPANY_CAPITAL", "NEXT_PUBLIC_LEGAL_COMPANY_SHARE_CAPITAL"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /company capital/);
  assert.match(result.stderr, /NEXT_PUBLIC_LEGAL_COMPANY_CAPITAL/);
});

test("le contrôle juridique refuse un directeur de publication absent", () => {
  const result = runChecker({}, ["NEXT_PUBLIC_LEGAL_PUBLISHER_DIRECTOR", "NEXT_PUBLIC_LEGAL_DIRECTOR_PUBLICATION"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /publisher director/);
  assert.match(result.stderr, /NEXT_PUBLIC_LEGAL_PUBLISHER_DIRECTOR/);
});

test("le contrôle juridique exige une adresse publique vers le code source", () => {
  const result = runChecker({}, ["NEXT_PUBLIC_SOURCE_CODE_URL"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source code URL/);
  assert.match(result.stderr, /NEXT_PUBLIC_SOURCE_CODE_URL/);
});

test("le contrôle juridique refuse une adresse de code source locale", () => {
  const result = runChecker({ NEXT_PUBLIC_SOURCE_CODE_URL: "http://localhost:3000/source" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source code URL invalide/);
});
