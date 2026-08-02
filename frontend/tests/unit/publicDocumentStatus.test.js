const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const loadStatusModule = () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/lib/publicDocumentStatus.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
  }).outputText;
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports };
  vm.createContext(sandbox);
  new vm.Script(compiled, { filename: "publicDocumentStatus.ts" }).runInContext(sandbox);
  return module.exports;
};

test("les statuts publics de remboursement sont traduits", () => {
  const { publicDocumentStatusLabel } = loadStatusModule();

  assert.equal(publicDocumentStatusLabel("refunded", "invoice"), "Remboursée");
  assert.equal(publicDocumentStatusLabel("PARTIALLY_REFUNDED", "invoice"), "Partiellement remboursée");
});

test("un statut technique inconnu n'est jamais affiché dans un portail public", () => {
  const { publicDocumentStatusLabel } = loadStatusModule();

  assert.equal(publicDocumentStatusLabel("provider_reconciliation_pending_v2", "invoice"), "Statut en cours");
  assert.equal(publicDocumentStatusLabel("unexpected_quote_state", "quote"), "Statut en cours");
  assert.equal(publicDocumentStatusLabel(null, "invoice"), "Statut en cours");
});
