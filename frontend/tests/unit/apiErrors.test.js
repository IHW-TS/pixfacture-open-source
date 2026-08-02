const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const loadApiModule = () => {
  const sourcePath = path.join(__dirname, "../../src/lib/api.ts");
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
    console,
    process: { env: { NODE_ENV: "test" } },
    require: (request) => {
      if (request === "./authCookies") {
        return {
          clearCachedCsrfToken: () => {},
          getCsrfToken: async () => "",
          logout: () => {},
        };
      }
      if (request === "./auth") {
        return {
          defaultAuthCredentials: "include",
          getAuthHeader: () => ({}),
          getRefreshToken: () => "",
          isCookieAuthMode: () => true,
          setAuthTokens: () => {},
        };
      }
      if (request === "./apiConfig") {
        return {
          apiBase: "",
          apiOrigin: () => "",
          apiUrl: (value) => value,
        };
      }
      if (request === "./devPages") return { shouldHideDevPages: () => true };
      if (request === "./internal") return { getInternalUser: () => null };
      if (request === "./invoiceComplianceUi") {
        const source = fs.readFileSync(path.join(__dirname, "../../src/lib/invoiceComplianceUi.ts"), "utf8");
        const output = ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
        }).outputText;
        const nestedModule = { exports: {} };
        const nestedSandbox = { module: nestedModule, exports: nestedModule.exports, require };
        vm.createContext(nestedSandbox);
        new vm.Script(output, { filename: "invoiceComplianceUi.ts" }).runInContext(nestedSandbox);
        return nestedModule.exports;
      }
      return require(request);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(compiled, { filename: "api.ts" }).runInContext(sandbox);
  return module.exports;
};

test("API error messages keep user-facing quota messages", () => {
  const { extractUserFacingApiMessage, formatApiError } = loadApiModule();

  const payload = { error: "quota_exceeded", message: "Votre quota est atteint pour ce mois." };
  assert.equal(
    extractUserFacingApiMessage(payload, 402, "Action impossible."),
    "Votre quota est atteint pour ce mois.",
  );

  assert.equal(
    formatApiError({ status: 402, code: "quota_exceeded", message: payload.message }, "Action impossible."),
    "Votre quota est atteint pour ce mois.",
  );
});

test("API error messages keep the login retry delay", () => {
  const { extractUserFacingApiMessage, formatApiError } = loadApiModule();
  const message = "Trop de tentatives. Réessayez dans 15 minutes.";
  const payload = { error: { code: "login_rate_limited", message } };

  assert.equal(extractUserFacingApiMessage(payload, 429, "Identifiants invalides"), message);
  assert.equal(formatApiError({ status: 429, code: "login_rate_limited", message }, "Identifiants invalides"), message);
});

test("API error messages hide technical codes and internals", () => {
  const { extractUserFacingApiMessage, formatApiError, sanitizeUserFacingApiMessage } = loadApiModule();

  assert.equal(
    extractUserFacingApiMessage({ error: "quota_exceeded" }, 402, "Action impossible."),
    "Action impossible.",
  );
  assert.equal(
    sanitizeUserFacingApiMessage("foreign key constraint failed", 400, "Action impossible."),
    "Action impossible.",
  );
  assert.equal(
    sanitizeUserFacingApiMessage("Validation interne échouée.", 422, "Action impossible."),
    "Action impossible.",
  );
  assert.equal(
    formatApiError({ status: 500, message: "Internal Server Error request_id=abc" }),
    "Service momentanément indisponible. Réessayez dans quelques instants.",
  );
});

test("API 404 messages translate generic backend not-found copy", () => {
  const { extractUserFacingApiMessage, formatApiError, sanitizeUserFacingApiMessage } = loadApiModule();

  assert.equal(sanitizeUserFacingApiMessage("Not found", 404), "Élément introuvable.");
  assert.equal(
    sanitizeUserFacingApiMessage("Not found", 404, "Facture introuvable."),
    "Facture introuvable.",
  );
  assert.equal(
    extractUserFacingApiMessage({ detail: "Supplier not found" }, 404, "Fournisseur introuvable."),
    "Fournisseur introuvable.",
  );
  assert.equal(formatApiError({ status: 404, message: "Not found" }), "Élément introuvable.");
});

test("API error messages hide raw browser network failures", () => {
  const { formatApiError, sanitizeUserFacingApiMessage } = loadApiModule();
  const fallback = "Action momentanément indisponible.";

  for (const rawMessage of [
    "Failed to fetch",
    "TypeError: Failed to fetch",
    "TypeError: fetch failed",
    "NetworkError when attempting to fetch resource.",
    "Network Error",
    "Network request failed",
    "Load failed",
    "The network connection was lost.",
    "The Internet connection appears to be offline.",
  ]) {
    assert.equal(sanitizeUserFacingApiMessage(rawMessage, 0, fallback), fallback, rawMessage);
    assert.equal(formatApiError({ status: 0, message: rawMessage }, fallback), fallback, rawMessage);
  }
});

test("API error messages hide infrastructure errors and configuration names", () => {
  const { formatApiError, sanitizeUserFacingApiMessage } = loadApiModule();
  const fallback = "Action momentanément indisponible.";

  for (const rawMessage of [
    "[Errno 111] Connection refused",
    "connect ECONNREFUSED 127.0.0.1:6379",
    "redis://user:secret@cache:6379/0",
    "postgresql://db-user:secret@db:5432/app",
    "Unable to read /srv/pixfacture/config.json",
    "Missing SEQINO_ACCESS_TOKEN",
    "PISTE_CLIENT_SECRET is invalid",
    "S3_BUCKET is missing",
    "TypeError: Cannot read properties of undefined",
    "KeyError: 'tenant_id'",
    "AccessDenied from https://s3.internal.example.test/bucket",
    "<!DOCTYPE html><html><body>Bad Gateway</body></html>",
  ]) {
    assert.equal(sanitizeUserFacingApiMessage(rawMessage, 409, fallback), fallback, rawMessage);
    assert.equal(formatApiError({ status: 409, message: rawMessage }, fallback), fallback, rawMessage);
  }
});

test("API error messages translate common validation bounds", () => {
  const { formatApiError, sanitizeUserFacingApiMessage } = loadApiModule();

  assert.equal(
    sanitizeUserFacingApiMessage("Input should be less than or equal to 100", 422, "Action impossible."),
    "La valeur doit être inférieure ou égale à 100.",
  );
  assert.equal(
    formatApiError(
      {
        status: 422,
        message: "Enregistrement impossible.",
        errors: [{ field: "discount", msg: "Input should be less than or equal to 100" }],
      },
      "Action impossible.",
    ),
    "Enregistrement impossible. À corriger : La valeur doit être inférieure ou égale à 100.",
  );
});

test("API error messages explain e-invoicing unit code errors", () => {
  const { formatApiError, sanitizeUserFacingApiMessage } = loadApiModule();
  const raw =
    "[fatal] [BR-CL-23]-Unit code MUST be coded according to the UN/ECE Recommendation 20 with Rec 21 extension (location: /*:CrossIndustryInvoice/*:SupplyChainTradeTransaction/*:IncludedSupplyChainTradeLineItem/*:SpecifiedLineTradeDelivery/*:BilledQuantity)";
  const expected =
    "Une ligne du document contient une unité ou une quantité non acceptée pour l'e-facturation. Vérifiez les lignes, puis relancez l'action.";

  assert.equal(sanitizeUserFacingApiMessage(raw, 422, "Émission impossible."), expected);
  assert.equal(formatApiError({ status: 422, message: raw }, "Émission impossible."), expected);
  assert.equal(formatApiError({ status: 422, message: raw, errors: [raw] }, "Émission impossible."), expected);
});

test("API error details never append structured machine field names", () => {
  const { formatApiError, sanitizeUserFacingApiMessage } = loadApiModule();
  const message = formatApiError(
    {
      status: 422,
      message: "Émission impossible.",
      errors: [
        "invoice.operation_nature: Indiquez la nature de l'operation (biens/services/mixte).",
        "lines[2].exemption_reason_code: Renseignez le motif d'exoneration de TVA.",
      ],
    },
    "Émission impossible.",
  );

  assert.doesNotMatch(message, /invoice\.|lines\[\d+]|exemption_reason_code/);
  assert.match(message, /nature de l’opération/);
  assert.match(message, /motif d’exonération de TVA/);
  assert.equal(
    sanitizeUserFacingApiMessage("invoice.operation_nature", 422, "Émission impossible."),
    "Choisissez la nature de l’opération : biens, services ou mixte.",
  );
});
