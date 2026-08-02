const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const loadModule = () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/lib/invoiceComplianceUi.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, require };
  vm.createContext(sandbox);
  new vm.Script(compiled, { filename: "invoiceComplianceUi.ts" }).runInContext(sandbox);
  return module.exports;
};

test("les erreurs de conformité facture sont traduites, dédupliquées et dirigées vers le bon écran", () => {
  const { buildInvoiceComplianceUiItems } = loadModule();
  const items = buildInvoiceComplianceUiItems({
    fields: ["tenant.siret", "customer.siren", "customer.siret", "invoice.operation_nature", "invoice.lines.quantity"],
    errors: [
      "customer.siren: Renseignez le SIREN du client (B2B France).",
      "lines[2].exemption_reason_code: Renseignez le motif d'exoneration de TVA.",
      "invoice.total_inc_vat: Le montant TTC doit etre egal a HT + TVA.",
      "unexpected.internal_field",
    ],
    invoiceId: "inv 42",
    customerId: "client 7",
  });

  assert.equal(items.length, 7);
  assert.equal(items.filter((item) => item.href === "/app/customers/client%207").length, 1);
  assert.ok(items.some((item) => item.href === "/app/company" && item.actionLabel === "Compléter l’entreprise"));
  assert.ok(
    items.some(
      (item) => item.href === "/app/invoices/new?edit_invoice=inv%2042" && item.actionLabel === "Modifier la facture",
    ),
  );
  assert.ok(items.some((item) => item.label === "Ligne 2 : renseignez le motif d’exonération de TVA."));
  for (const item of items) {
    assert.doesNotMatch(item.label, /(?:tenant|customer|invoice)\.|lines\[\d+]|internal_field/i);
  }
});

test("les détails techniques de conformité sont remplacés par une consigne utilisateur", () => {
  const { sanitizeStructuredInvoiceErrorDetail } = loadModule();

  assert.equal(
    sanitizeStructuredInvoiceErrorDetail(
      "invoice.operation_nature: Indiquez la nature de l'operation (biens/services/mixte - categories LB/PS/LBPS).",
    ),
    "Choisissez la nature de l’opération : biens, services ou mixte.",
  );
  assert.equal(
    sanitizeStructuredInvoiceErrorDetail(
      "[BR-CL-23] Unit code MUST be coded according to the UN/ECE Recommendation 20 (location: /rsm:CrossIndustryInvoice)",
    ),
    "Vérifiez la quantité et l’unité des lignes de la facture.",
  );
});
