const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const script = path.resolve(__dirname, "../../scripts/public-build-attestation.mjs");

const writeEnv = (directory) => {
  const envFile = path.join(directory, "frontend.prod.env");
  fs.writeFileSync(
    envFile,
    [
      "NEXT_PUBLIC_COMPLIANCE_CLAIM_LEVEL=export_only",
      "NEXT_PUBLIC_ENABLE_EINVOICING_PAGES=true",
      "NEXT_PUBLIC_ENABLE_PDP_INTEGRATION=false",
      "NEXT_PUBLIC_ENABLE_PPF_DIRECTORY=false",
      "NEXT_PUBLIC_MVP_COMMERCIAL_MODE=on",
      "NEXT_PUBLIC_LEGAL_DOC_VERSION_TERMS=2026-07-12",
      "NEXT_PUBLIC_LEGAL_DOC_VERSION_CGV=2026-07-12",
      "NEXT_PUBLIC_LEGAL_DOC_VERSION_DPA=2026-07-12",
      "NEXT_PUBLIC_LEGAL_DOC_VERSION_PRIVACY=2026-07-12",
      "NEXT_PUBLIC_LEGAL_DOC_VERSION_COOKIES=2026-07-12",
      "",
    ].join("\n"),
  );
  return envFile;
};

test("public build attestation contains only canonical public configuration", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixfacture-public-attestation-"));
  try {
    const envFile = writeEnv(directory);
    const output = path.join(directory, "attestation.json");
    execFileSync(process.execPath, [script, "--env-file", envFile, "--output", output]);
    const report = JSON.parse(fs.readFileSync(output, "utf8"));

    assert.deepEqual(Object.keys(report).sort(), ["config", "config_sha256", "kind", "version"]);
    assert.equal(report.config.compliance.export_only, true);
    assert.equal(report.config.pricing.subscription_plans.starter.monthly, 2900);
    assert.equal(report.config.pricing.subscription_plans.pro.yearly, 59000);
    assert.equal(report.config.legal_document_versions.cgv, "2026-07-12");
    assert.match(report.config_sha256, /^[0-9a-f]{64}$/);
    execFileSync(process.execPath, [script, "--env-file", envFile, "--verify", output]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("public build attestation verification rejects a changed compiled price", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixfacture-public-attestation-"));
  try {
    const envFile = writeEnv(directory);
    const output = path.join(directory, "attestation.json");
    execFileSync(process.execPath, [script, "--env-file", envFile, "--output", output]);
    const report = JSON.parse(fs.readFileSync(output, "utf8"));
    report.config.pricing.subscription_plans.pro.monthly = 1;
    fs.writeFileSync(output, JSON.stringify(report));

    const verification = spawnSync(process.execPath, [script, "--env-file", envFile, "--verify", output], {
      encoding: "utf8",
    });
    assert.notEqual(verification.status, 0);
    assert.match(verification.stderr, /ne correspond pas/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
