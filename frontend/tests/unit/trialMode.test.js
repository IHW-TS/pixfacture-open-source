const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const loadModule = () => {
  const sourcePath = path.join(__dirname, "../../src/lib/trialMode.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, require };
  vm.createContext(sandbox);
  new vm.Script(compiled, { filename: "trialMode.ts" }).runInContext(sandbox);
  return module.exports;
};

test("trial status normalization is strict and predictable", () => {
  const { isTrialSubscription } = loadModule();
  assert.equal(isTrialSubscription(" trialing "), true);
  assert.equal(isTrialSubscription("trial"), true);
  assert.equal(isTrialSubscription("active"), false);
  assert.equal(isTrialSubscription(null), false);
});

test("trial capabilities expose Pro preparation but disable every live connector", () => {
  const { restrictCapabilitiesForTrial } = loadModule();
  const restricted = restrictCapabilitiesForTrial(
    {
      plan: "pro",
      billing_enabled: true,
      purchases_enabled: true,
      payments_enabled: true,
      einvoicing_available_by_plan: true,
      chorus_available_by_plan: true,
      seqino_available_by_plan: true,
      token_topup_available_by_plan: true,
      einvoicing_operational: true,
      chorus_operational: true,
      seqino_operational: true,
      einvoicing_enabled: true,
      chorus_enabled: true,
      seqino_enabled: true,
      token_topup_enabled: true,
    },
    "trialing",
  );

  assert.equal(restricted.plan, "pro");
  assert.equal(restricted.purchases_enabled, true);
  assert.equal(restricted.payments_enabled, true);
  for (const key of [
    "einvoicing_available_by_plan",
    "chorus_available_by_plan",
    "seqino_available_by_plan",
    "token_topup_available_by_plan",
    "einvoicing_enabled",
  ]) {
    assert.equal(restricted[key], true, `${key} doit rester visible pendant l'essai Pro`);
  }
  for (const key of [
    "einvoicing_operational",
    "chorus_operational",
    "seqino_operational",
    "chorus_enabled",
    "seqino_enabled",
    "token_topup_enabled",
  ]) {
    assert.equal(restricted[key], false, `${key} doit rester désactivé pendant l'essai`);
  }
});

test("active subscriptions preserve their server capabilities", () => {
  const { restrictCapabilitiesForTrial } = loadModule();
  const capabilities = { plan: "pro", seqino_enabled: true };
  assert.equal(restrictCapabilitiesForTrial(capabilities, "active"), capabilities);
});
