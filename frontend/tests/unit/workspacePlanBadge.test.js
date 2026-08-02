const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const loadModule = () => {
  const sourcePath = path.join(__dirname, "../../src/lib/subscriptionDisplay.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require: (request) => {
      if (request === "./billingConstants") return { TRIAL_DAYS: 7 };
      return require(request);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(compiled, { filename: "subscriptionDisplay.ts" }).runInContext(sandbox);
  return module.exports;
};

test("trial status takes priority over the underlying plan", () => {
  const { getWorkspacePlanBadge } = loadModule();
  assert.deepEqual(JSON.parse(JSON.stringify(getWorkspacePlanBadge("pro", "trialing"))), {
    id: "trial",
    label: "Essai",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(getWorkspacePlanBadge("starter", "trial"))), {
    id: "trial",
    label: "Essai",
  });
});

test("active workspaces display their current commercial plan", () => {
  const { getWorkspacePlanBadge } = loadModule();
  assert.equal(getWorkspacePlanBadge("starter", "active").label, "Starter");
  assert.equal(getWorkspacePlanBadge("pro", "active").label, "Pro");
  assert.equal(getWorkspacePlanBadge(null, "active"), null);
});
