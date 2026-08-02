const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const createStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};

const jsonResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const loadUseSession = ({ responses, hadSession, refreshResult = null }) => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/lib/useSession.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const module = { exports: {} };
  const storage = createStorage();
  const logoutCalls = [];
  let refreshCalls = 0;
  const queue = [...responses];
  const window = {
    location: { pathname: "/app/invoices/42", search: "?panel=transmission", hash: "#status" },
    sessionStorage: storage,
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const document = {
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const sandbox = {
    module,
    exports: module.exports,
    console,
    process: { env: { NODE_ENV: "test" } },
    window,
    document,
    Date,
    require: (request) => {
      if (request === "react") return { useEffect: () => {}, useState: (initial) => [initial, () => {}] };
      if (request === "./api") {
        return {
          apiUrl: (value) => value,
          fetchWithTimeout: async () => queue.shift(),
          refreshSession: async () => {
            refreshCalls += 1;
            return refreshResult;
          },
        };
      }
      if (request === "./auth") return { defaultAuthCredentials: () => "include", getAuthHeader: () => ({}) };
      if (request === "./authCookies") {
        return { logout: async (options) => logoutCalls.push(options) };
      }
      if (request === "./internal") return { setInternalUser: () => {} };
      if (request === "./sessionFlags") return { hasHadSession: () => hadSession };
      if (request === "./sessionRoutes") return { shouldRedirectExpiredSession: () => true };
      if (request === "./productCapabilities") return { resolveProductCapabilities: (value) => value || {} };
      if (request === "./trialMode") return { restrictCapabilitiesForTrial: (value) => value || {} };
      return require(request);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(compiled, { filename: "useSession.ts" }).runInContext(sandbox);
  return { useSession: module.exports, storage, logoutCalls, getRefreshCalls: () => refreshCalls };
};

test("un 403 MFA sur une session ouverte redirige vers la reconnexion et conserve le retour", async () => {
  const harness = loadUseSession({
    responses: [jsonResponse(403, { detail: { code: "mfa_setup_required" } })],
    hadSession: false,
  });

  await harness.useSession.refreshSession(true);

  assert.equal(
    harness.useSession.getSessionSnapshot().error,
    "Double authentification requise. Reconnectez-vous pour terminer son activation.",
  );
  assert.equal(
    harness.storage.getItem("login_notice"),
    "Double authentification requise. Reconnectez-vous pour terminer son activation.",
  );
  assert.equal(harness.logoutCalls.length, 1);
  assert.equal(harness.logoutCalls[0].returnTo, "/app/invoices/42?panel=transmission#status");
});

test("le même parcours MFA est appliqué après une actualisation de session", async () => {
  const harness = loadUseSession({
    responses: [
      jsonResponse(401, { detail: { code: "session_expired" } }),
      jsonResponse(403, { error: { code: "mfa_setup_required" } }),
    ],
    hadSession: true,
    refreshResult: "cookie",
  });

  await harness.useSession.refreshSession(true);

  assert.equal(harness.getRefreshCalls(), 1);
  assert.equal(harness.logoutCalls.length, 1);
  assert.equal(harness.useSession.getSessionSnapshot().user, null);
});
