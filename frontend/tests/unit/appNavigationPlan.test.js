const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const loadNavigation = () => {
  const sourcePath = path.join(__dirname, "../../src/lib/appNavigation.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    process: { env: {} },
    require: (request) => {
      if (request === "./permissions") {
        return {
          canAccessAppPath: () => true,
          normalizeAppRole: (session) => session?.role || null,
        };
      }
      return require(request);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(compiled, { filename: "appNavigation.ts" }).runInContext(sandbox);
  return module.exports;
};

test("Starter navigation excludes purchases, payments and e-invoicing", () => {
  const { getAppNavigationModules } = loadNavigation();
  const ids = getAppNavigationModules({ role: "owner" }, "starter").map((item) => item.id);
  assert.equal(ids.includes("purchases"), false);
  assert.equal(ids.includes("cash"), false);
  assert.equal(ids.includes("einvoicing"), false);
  assert.equal(ids.includes("quotes"), true);
  assert.equal(ids.includes("invoices"), true);
});

test("Pro navigation includes purchases, payments and e-invoicing", () => {
  const { getAppNavigationModules, isAppModuleActive } = loadNavigation();
  const ids = getAppNavigationModules({ role: "owner" }, "pro").map((item) => item.id);
  assert.equal(ids.includes("purchases"), true);
  assert.equal(ids.includes("cash"), true);
  assert.equal(ids.includes("einvoicing"), true);

  const einvoicing = getAppNavigationModules({ role: "owner" }, "pro").find((item) => item.id === "einvoicing");
  for (const path of ["/app/pdp", "/app/settings/einvoicing", "/app/settings/platforms"]) {
    assert.equal(isAppModuleActive(path, einvoicing), true, `${path} doit garder E-facturation active`);
  }
});

test("profile navigation keeps visual identity inside the company page", () => {
  const { getProfileNavigationItems } = loadNavigation();
  const branding = getProfileNavigationItems({ session: { role: "owner" } }).find((item) => item.id === "branding");

  assert.equal(branding, undefined);
});
