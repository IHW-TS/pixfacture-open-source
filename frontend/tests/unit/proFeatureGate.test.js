const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const loadModule = () => {
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
  new vm.Script(compiled, { filename: "productCapabilities.ts" }).runInContext(sandbox);
  return module.exports;
};

test("Starter conserve le CTA de montée vers Pro", () => {
  const { resolveProFeatureGate } = loadModule();

  for (const feature of ["payments", "purchases", "einvoicing"]) {
    const gate = resolveProFeatureGate(
      {
        [`${feature}_available_by_plan`]: false,
        [`${feature}_enabled`]: false,
      },
      feature,
    );

    assert.equal(gate.enabled, false);
    assert.equal(gate.reactivationRequired, false);
    assert.equal(gate.statusLabel, "Plan Pro requis");
    assert.equal(gate.ctaLabel, "Passer au plan Pro");
    assert.equal(gate.ctaHref, "/app/billing");
  }
});

test("Pro suspendu demande une réactivation sans proposer un nouveau plan", () => {
  const { resolveProFeatureGate } = loadModule();

  for (const feature of ["payments", "purchases", "einvoicing"]) {
    const gate = resolveProFeatureGate(
      {
        [`${feature}_available_by_plan`]: true,
        [`${feature}_enabled`]: false,
      },
      feature,
    );

    assert.equal(gate.enabled, false);
    assert.equal(gate.availableByPlan, true);
    assert.equal(gate.reactivationRequired, true);
    assert.equal(gate.statusLabel, "Abonnement Pro à réactiver");
    assert.equal(gate.ctaLabel, "Réactiver l’abonnement Pro");
    assert.equal(gate.ctaHref, "/app/billing");
    assert.match(gate.reactivationDescription, /dispose déjà du plan Pro/i);
  }
});

test("Pro actif conserve l’accès aux fonctionnalités", () => {
  const { resolveProFeatureGate } = loadModule();

  for (const feature of ["payments", "purchases", "einvoicing"]) {
    const gate = resolveProFeatureGate(
      {
        [`${feature}_available_by_plan`]: true,
        [`${feature}_enabled`]: true,
      },
      feature,
    );

    assert.equal(gate.enabled, true);
    assert.equal(gate.reactivationRequired, false);
  }
});
