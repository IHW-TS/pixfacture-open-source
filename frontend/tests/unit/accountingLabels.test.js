const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");

const extractConstBlock = (source, constName) => {
  const start = source.indexOf(`const ${constName} = [`);
  assert.notEqual(start, -1, `${constName} must exist`);
  const end = source.indexOf("];", start);
  assert.notEqual(end, -1, `${constName} must end`);
  return source.slice(start, end);
};

test("purchase accounting fallback 471 is last and user-facing", () => {
  const source = read("src/figma/app/pages/app/EinvoicingPages.tsx");
  const block = extractConstBlock(source, "purchaseAccountingAccountOptions");

  const fallbackLabel = 'label: "Je ne sais pas / demander au comptable · 471"';
  assert.ok(block.includes(fallbackLabel));
  assert.ok(block.lastIndexOf('value: "471"') > block.indexOf('value: "627"'));
  assert.equal(block.includes('label: "À valider par mon comptable · 471"'), false);
});

test("sales accounting fallback 471 is last and does not start with an account code", () => {
  const source = read("src/figma/app/components/app/InvoiceDocumentEditor.tsx");
  const block = extractConstBlock(source, "SALES_ACCOUNT_OPTIONS");

  const fallbackLabel = 'label: "Je ne sais pas / demander au comptable · 471"';
  assert.ok(block.includes(fallbackLabel));
  assert.ok(block.lastIndexOf('value: "471"') > block.indexOf('value: "7085"'));
  assert.equal(block.includes('label: "471 - À catégoriser (temporaire)"'), false);
  assert.equal(/label:\s*"471\b/.test(block), false);
});

test("payment accounting fallback label is user-facing in invoice page", () => {
  const source = read("src/figma/app/pages/app/InvoicesPage.tsx");

  assert.ok(source.includes('"Je ne sais pas / demander au comptable · 471"'));
  assert.equal(/(?:label|category):\s*"471\b/.test(source), false);
  assert.equal(source.includes('"471 À catégoriser"'), false);
});
