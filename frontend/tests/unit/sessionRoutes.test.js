const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const loadSessionRoutesModule = () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/lib/sessionRoutes.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, require };
  vm.createContext(sandbox);
  new vm.Script(compiled, { filename: "sessionRoutes.ts" }).runInContext(sandbox);
  return module.exports;
};

test("une session expirée ne redirige que les espaces protégés", () => {
  const { shouldRedirectExpiredSession } = loadSessionRoutesModule();

  for (const pathname of ["/app", "/app/dashboard", "/app/invoices/123", "/admin", "/admin/readiness"]) {
    assert.equal(shouldRedirectExpiredSession(pathname), true, pathname);
  }

  for (const pathname of [
    "/",
    "/pricing",
    "/features",
    "/i/public-token",
    "/q/public-token",
    "/c/public-token",
    "/app/login",
    "/app/register",
    "/app/password-reset/confirm",
    "/app/verify-email",
    "/app/invites/accept",
  ]) {
    assert.equal(shouldRedirectExpiredSession(pathname), false, pathname);
  }
});
