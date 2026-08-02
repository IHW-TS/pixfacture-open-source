const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const loadModule = () => {
  const sourcePath = path.join(__dirname, "../../src/lib/verifiedBillingIntent.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
  }).outputText;
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, require, URLSearchParams };
  vm.createContext(sandbox);
  new vm.Script(compiled, { filename: "verifiedBillingIntent.ts" }).runInContext(sandbox);
  return module.exports;
};

const createStorage = (entries = {}) => {
  const values = new Map(Object.entries(entries));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};

test("accepts only the server billing intent allowlist", () => {
  const { parseVerifiedBillingIntent } = loadModule();
  const validIntent = parseVerifiedBillingIntent({
    billing_intent: {
      plan: "pro",
      period: "yearly",
      checkout_requested: true,
      destination: "billing",
      tenant_id: "must-not-be-used",
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(validIntent)), {
    plan: "pro",
    period: "yearly",
    checkoutRequested: true,
    destination: "billing",
  });
  assert.equal(
    parseVerifiedBillingIntent({
      billing_intent: {
        plan: "enterprise",
        period: "yearly",
        checkout_requested: true,
        destination: "billing",
      },
    }),
    null,
  );
  assert.equal(
    parseVerifiedBillingIntent({
      billing_intent: {
        plan: "pro",
        period: "yearly",
        checkout_requested: false,
        destination: "billing",
      },
    }),
    null,
  );
});

test("a verified paid intent is normalized to the Pro trial company destination", () => {
  const { persistVerifiedBillingIntent, postVerifyPathFromStorage } = loadModule();
  const storage = createStorage({
    preferred_plan: "starter",
    preferred_billing_period: "monthly",
  });
  persistVerifiedBillingIntent(storage, {
    plan: "pro",
    period: "yearly",
    checkoutRequested: true,
    destination: "billing",
  });
  assert.equal(storage.getItem("preferred_plan"), "pro");
  assert.equal(storage.getItem("preferred_billing_period"), "yearly");
  assert.equal(storage.getItem("preferred_checkout"), null);
  assert.equal(storage.getItem("preferred_post_verify_destination"), "onboarding");
  assert.equal(postVerifyPathFromStorage(storage), "/app/company?welcome=1");
});

test("a verified trial intent routes to the company profile and clears a stale checkout", () => {
  const { persistVerifiedBillingIntent, postVerifyPathFromStorage } = loadModule();
  const storage = createStorage({ preferred_checkout: "1" });
  persistVerifiedBillingIntent(storage, {
    plan: "starter",
    period: "monthly",
    checkoutRequested: false,
    destination: "onboarding",
  });
  assert.equal(storage.getItem("preferred_checkout"), null);
  assert.equal(postVerifyPathFromStorage(storage), "/app/company?welcome=1");
});

test("rejects inconsistent or locally forged persisted destinations", () => {
  const { postVerifyPathFromStorage } = loadModule();
  const staleCheckout = createStorage({
    preferred_plan: "pro",
    preferred_billing_period: "yearly",
    preferred_checkout: "1",
    preferred_post_verify_destination: "onboarding",
  });
  assert.equal(postVerifyPathFromStorage(staleCheckout), "/app/company?welcome=1");
  assert.equal(staleCheckout.getItem("preferred_checkout"), null);
  assert.equal(
    postVerifyPathFromStorage(
      createStorage({
        preferred_plan: "enterprise",
        preferred_billing_period: "yearly",
        preferred_checkout: "1",
        preferred_post_verify_destination: "billing",
      }),
    ),
    null,
  );
});
