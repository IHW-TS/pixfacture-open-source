const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const loadProductCapabilitiesModule = () => {
  const sourcePath = path.join(__dirname, "../../src/lib/productCapabilities.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
  }).outputText;

  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require: (request) => {
      if (request === "./plans") {
        return {
          normalizePlan: (value) => {
            const raw = String(value || "")
              .trim()
              .toLowerCase();
            return raw === "pro" || raw === "enterprise" ? raw : "starter";
          },
        };
      }
      return require(request);
    },
  };
  vm.createContext(sandbox);
  const script = new vm.Script(compiled, { filename: "productCapabilities.ts" });
  script.runInContext(sandbox);
  return module.exports;
};

test("session capabilities stay restrictive when backend capabilities are missing", () => {
  const { resolveProductCapabilities, hasProductFeature } = loadProductCapabilitiesModule();
  const resolved = resolveProductCapabilities(null, "pro");

  assert.equal(resolved.plan, "pro");
  assert.equal(resolved.einvoicing_enabled, false);
  assert.equal(resolved.chorus_enabled, false);
  assert.equal(resolved.seqino_enabled, false);
  assert.equal(resolved.token_topup_enabled, false);
  assert.equal(resolved.purchases_enabled, false);
  assert.equal(resolved.payments_enabled, false);
  assert.equal(hasProductFeature(null, "seqino_enabled", "pro"), false);
});

test("session capabilities use explicit backend feature flags", () => {
  const { resolveProductCapabilities, hasProductFeature } = loadProductCapabilitiesModule();
  const payload = {
    plan: "pro",
    billing_enabled: true,
    einvoicing_enabled: true,
    chorus_enabled: true,
    seqino_enabled: true,
    token_topup_enabled: true,
    purchases_enabled: true,
    payments_enabled: true,
  };
  const resolved = resolveProductCapabilities(payload, "starter");

  assert.equal(resolved.plan, "pro");
  assert.equal(resolved.einvoicing_enabled, true);
  assert.equal(resolved.chorus_enabled, true);
  assert.equal(resolved.seqino_enabled, true);
  assert.equal(resolved.token_topup_enabled, true);
  assert.equal(resolved.purchases_enabled, true);
  assert.equal(resolved.payments_enabled, true);
  assert.equal(hasProductFeature(payload, "seqino_enabled", "starter"), true);
});
