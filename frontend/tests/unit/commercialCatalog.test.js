const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createRequire } = require("node:module");

const loadCommercialCatalog = () => {
  const sourcePath = path.join(__dirname, "../../src/lib/commercialCatalog.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, require: createRequire(sourcePath) };
  vm.createContext(sandbox);
  new vm.Script(compiled, { filename: "commercialCatalog.ts" }).runInContext(sandbox);
  return module.exports;
};

test("commercial catalog keeps subscription fallback amounts centralized", () => {
  const { SUBSCRIPTION_PLAN_PRICES_CENTS } = loadCommercialCatalog();

  assert.equal(SUBSCRIPTION_PLAN_PRICES_CENTS.starter.monthly, 2900);
  assert.equal(SUBSCRIPTION_PLAN_PRICES_CENTS.starter.yearly, 29000);
  assert.equal(SUBSCRIPTION_PLAN_PRICES_CENTS.pro.monthly, 5900);
  assert.equal(SUBSCRIPTION_PLAN_PRICES_CENTS.pro.yearly, 59000);
});

test("commercial catalog keeps token pack fallback amounts centralized", () => {
  const { TOKEN_PACK_OFFERS } = loadCommercialCatalog();

  assert.deepEqual(Object.keys(TOKEN_PACK_OFFERS), ["100", "500", "1000", "5000"]);
  assert.equal(TOKEN_PACK_OFFERS[100].unit_amount, 2900);
  assert.equal(TOKEN_PACK_OFFERS[5000].unit_amount, 119900);
});
