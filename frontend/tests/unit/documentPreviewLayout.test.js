const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");

test("invoice and quote editor preview wraps long content and exposes page guides", () => {
  const editor = read("src/figma/app/components/app/InvoiceDocumentEditor.tsx");
  const invoicesPage = read("src/figma/app/pages/app/InvoicesPage.tsx");
  const styles = read("src/figma/styles/index-next.css");
  const titleSectionStart = editor.indexOf('data-testid="document-title-section"');
  const titleSectionEnd = editor.indexOf('id="document-lines-section"', titleSectionStart);
  const titleSection = editor.slice(titleSectionStart, titleSectionEnd);

  assert.notEqual(titleSectionStart, -1);
  assert.notEqual(titleSectionEnd, -1);
  assert.match(titleSection, /<input/);
  assert.doesNotMatch(titleSection, /<textarea/);
  assert.equal(editor.includes('setFormField("document_title", event.target.value)'), true);
  assert.equal(styles.includes("--pf-preview-page-height: 1122px;"), true);
  assert.equal(styles.includes('[data-testid="invoice-document-preview"]::after'), true);
  assert.equal(styles.includes("[data-invoice-print-paper]::after"), false);
  assert.equal(styles.includes("repeating-linear-gradient"), true);
  assert.equal(styles.includes("overflow-wrap: anywhere"), true);
  assert.equal(styles.includes('[data-testid^="invoice-comment-row-"] textarea'), false);
  assert.equal(styles.includes('[data-testid="delivery-address-inline"]'), false);
  assert.equal(styles.includes("@media print"), true);
  assert.equal(styles.includes("[data-invoice-print-paper] :where(p, span, div, label, a, button"), false);
  assert.doesNotMatch(styles, /\[data-invoice-print-paper\][\s\S]{0,180}\[data-testid\^="invoice-comment-row-"\]/);
  assert.equal(invoicesPage.includes('data-testid="invoice-document-preview"'), true);
  assert.equal(invoicesPage.includes('"invoice-preview-comment-line"'), true);
  assert.equal(invoicesPage.includes("previewBreakLongTokens"), true);
  assert.equal(invoicesPage.includes('replace(/([^\\s]{18})(?=[^\\s])/g, "$1\\u200b")'), true);
  assert.equal(invoicesPage.includes('className="w-full min-w-0 table-fixed border-collapse bg-white"'), true);
  assert.equal(invoicesPage.includes("min-w-[900px] table-fixed"), false);
  assert.equal(invoicesPage.includes('overflowWrap: "anywhere"'), true);
  assert.equal(invoicesPage.includes('whiteSpace: "pre-wrap"'), true);
  assert.equal(invoicesPage.includes("[word-break:break-all]"), true);
  assert.equal(invoicesPage.includes("[overflow-wrap:anywhere]"), true);
});
