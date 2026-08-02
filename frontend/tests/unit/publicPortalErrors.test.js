const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const loadPortalErrorsModule = () => {
  const sourcePath = path.join(__dirname, "../../src/lib/publicPortalErrors.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
  }).outputText;

  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, require };
  vm.createContext(sandbox);
  new vm.Script(compiled, { filename: "publicPortalErrors.ts" }).runInContext(sandbox);
  return module.exports;
};

test("portal errors keep readable API messages and hide technical codes", () => {
  const { portalErrorMessage, PORTAL_ACTION_UNAVAILABLE } = loadPortalErrorsModule();

  assert.equal(portalErrorMessage("Le lien a expiré."), "Le lien a expiré.");
  assert.equal(portalErrorMessage("quota_exceeded"), PORTAL_ACTION_UNAVAILABLE);
  assert.equal(portalErrorMessage("Internal Server Error request_id=abc"), PORTAL_ACTION_UNAVAILABLE);
  assert.equal(portalErrorMessage("Failed to fetch"), PORTAL_ACTION_UNAVAILABLE);
  assert.equal(portalErrorMessage("Not found"), PORTAL_ACTION_UNAVAILABLE);
  assert.equal(portalErrorMessage("TypeError: fetch failed"), PORTAL_ACTION_UNAVAILABLE);
  assert.equal(portalErrorMessage("NetworkError when attempting to fetch resource."), PORTAL_ACTION_UNAVAILABLE);
});
