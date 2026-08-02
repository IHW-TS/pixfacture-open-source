const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const loadReadinessActions = () => {
  const sourcePath = path.join(__dirname, "../../src/lib/readinessActions.ts");
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
  new vm.Script(compiled, { filename: "readinessActions.ts" }).runInContext(sandbox);
  return module.exports;
};

test("nouvelle facture sans client -> Choisir un client", () => {
  const { resolveInvoiceReadinessNextAction } = loadReadinessActions();
  const action = resolveInvoiceReadinessNextAction({
    invoice: { status: "draft", customer_id: null, lines: [{ product_name: "Prestation" }] },
    readiness: { checks: [{ code: "customer_missing", severity: "blocking" }] },
  });
  assert.equal(action.kind, "choose_customer");
  assert.equal(action.label, "Choisir un client");
});

test("facture prête -> Émettre définitivement", () => {
  const { resolveInvoiceReadinessNextAction } = loadReadinessActions();
  const action = resolveInvoiceReadinessNextAction({
    invoice: {
      status: "draft",
      customer_id: "cus_1",
      balance_due: 120,
      lines: [{ product_name: "Prestation", line_type: "item" }],
    },
    readiness: { status: "ready", checks: [] },
  });
  assert.equal(action.kind, "issue_invoice");
  assert.equal(action.label, "Émettre définitivement");
});

test("nouveau devis sans client -> Choisir un client", () => {
  const { resolveQuoteReadinessNextAction } = loadReadinessActions();
  const action = resolveQuoteReadinessNextAction({
    quote: { status: "draft", customer_id: null, lines: [{ product_name: "Prestation" }] },
    readiness: { checks: [{ code: "customer_missing", severity: "blocking" }] },
  });
  assert.equal(action.kind, "choose_customer");
  assert.equal(action.label, "Choisir un client");
});

test("devis prêt -> Envoyer le devis", () => {
  const { resolveQuoteReadinessNextAction } = loadReadinessActions();
  const action = resolveQuoteReadinessNextAction({
    quote: { status: "draft", customer_id: "cus_1", lines: [{ product_name: "Prestation", line_type: "item" }] },
    readiness: { status: "ready", checks: [] },
  });
  assert.equal(action.kind, "send_quote");
  assert.equal(action.label, "Envoyer le devis");
});

test("devis accepté -> Créer la facture", () => {
  const { resolveQuoteReadinessNextAction } = loadReadinessActions();
  const action = resolveQuoteReadinessNextAction({
    quote: { status: "accepted", customer_id: "cus_1", lines: [{ product_name: "Prestation", line_type: "item" }] },
    readiness: { status: "ready", checks: [] },
  });
  assert.equal(action.kind, "create_invoice");
  assert.equal(action.label, "Créer la facture");
});

test("écrans actifs sans bannière contrôle avant émission/envoi", () => {
  const files = [
    "../../src/figma/app/pages/app/InvoicesPage.tsx",
    "../../src/figma/app/pages/app/QuotesPage.tsx",
    "../../src/figma/app/components/app/InvoiceDocumentEditor.tsx",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.equal(source.includes("Contrôle avant émission"), false, file);
    assert.equal(source.includes("Contrôle avant envoi"), false, file);
    assert.equal(source.includes("Voir les contrôles"), false, file);
  }
});

test("Options avancées orthographié correctement", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../src/figma/app/components/app/InvoiceDocumentEditor.tsx"),
    "utf8",
  );
  assert.ok(source.includes("Options avancées"));
  assert.equal(source.includes("Option avancée"), false);
});
