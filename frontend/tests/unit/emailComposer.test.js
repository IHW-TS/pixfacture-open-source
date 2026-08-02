const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");
const readRepo = (relativePath) => fs.readFileSync(path.join(__dirname, "../../..", relativePath), "utf8");

test("email composer uses stable variable controls and contact reply-to", () => {
  const invoiceModal = read("src/components/InvoiceEmailModal.tsx");
  const quoteModal = read("src/components/QuoteEmailModal.tsx");
  const editor = read("src/components/EmailBodyEditor.tsx");
  const invoicesPage = read("src/figma/app/pages/app/InvoicesPage.tsx");
  const quotesPage = read("src/figma/app/pages/app/QuotesPage.tsx");
  const invoiceRouter = readRepo("backend/app/routers/invoices.py");
  const quoteRouter = readRepo("backend/app/routers/quotes.py");
  const emailTemplate = readRepo("backend/app/templates/email/document.html");
  const oldQuickInfoTitle = "Informations " + "rapides";
  const oldFooterContactPhrase = "Pour toute question, " + "contactez";

  for (const source of [invoiceModal, quoteModal]) {
    assert.equal(source.includes(oldQuickInfoTitle), false);
    assert.equal(source.includes("De :"), true);
    assert.equal(source.includes("Contact :"), false);
    assert.equal(source.includes("reply_to"), true);
    assert.equal(source.includes("EmailBodyEditor"), true);
  }

  assert.equal(quoteModal.includes("Contacts facturation"), false);
  assert.equal(quoteModal.includes("Adresse spécifique"), false);
  assert.equal(quoteModal.includes("Format de pièce jointe"), false);
  assert.equal(quoteModal.includes("Réinitialiser le texte"), false);
  assert.equal(invoiceModal.includes("Réinitialiser le texte"), false);
  assert.equal(quoteModal.includes("Texte par défaut"), true);
  assert.equal(invoiceModal.includes("Texte par défaut"), true);
  assert.equal(quoteModal.includes("setSaveAsDefault(showSaveDefault)"), false);
  assert.equal(invoiceModal.includes("setSaveAsDefault(showSaveDefault)"), false);
  assert.equal(quoteModal.includes("Enregistrer par défaut"), true);
  assert.equal(invoiceModal.includes("Enregistrer par défaut"), true);
  assert.equal(quoteModal.includes("Enregistré le"), true);
  assert.equal(invoiceModal.includes("Enregistré le"), true);
  assert.equal(quoteModal.includes("formatSavedAt"), true);
  assert.equal(invoiceModal.includes("formatSavedAt"), true);
  assert.equal(quoteModal.includes("save_as_default: false"), true);
  assert.equal(invoiceModal.includes("save_as_default: false"), true);
  assert.equal(quoteModal.includes("defaultIncludePdf = false"), true);
  assert.equal(quoteModal.includes("defaultIncludeLink = false"), true);
  assert.equal(invoiceModal.includes("defaultAttachInvoice = false"), true);
  assert.equal(invoiceModal.includes("includeLink = false"), true);
  assert.equal(invoiceModal.includes("includeLink: includeClientLink"), true);
  assert.equal(editor.includes("Supprimer"), true);
  assert.equal(editor.includes("Remplacer par"), true);
  assert.equal(editor.includes("Modifier le texte"), false);
  assert.equal(editor.includes("<textarea"), false);
  assert.equal(editor.includes("contentEditable"), true);
  assert.equal(editor.includes("email-variable-token"), true);
  assert.equal(editor.includes("bg-blue-50"), false);
  assert.equal(editor.includes("topRightAction"), false);
  assert.equal(editor.includes("h-[360px]"), true);
  assert.equal(editor.includes("lg:h-[420px]"), true);
  assert.equal(quoteModal.includes("w-[calc(100vw-32px)] max-w-[1680px]"), true);
  assert.equal(invoiceModal.includes("w-[calc(100vw-32px)] max-w-[1680px]"), true);
  assert.equal(quoteModal.includes("lg:min-h-[560px]"), true);
  assert.equal(invoiceModal.includes("lg:min-h-[560px]"), true);
  assert.equal(quoteModal.includes("lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"), true);
  assert.equal(invoiceModal.includes("lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"), true);
  assert.equal(quoteModal.includes("lg:items-stretch"), true);
  assert.equal(invoiceModal.includes("lg:items-stretch"), true);
  assert.equal(
    quoteModal.includes("flex h-full min-h-[620px] w-full min-w-0 flex-col rounded-xl bg-slate-100 p-3"),
    true,
  );
  assert.equal(
    invoiceModal.includes("flex h-full min-h-[620px] w-full min-w-0 flex-col rounded-xl bg-slate-100 p-3"),
    true,
  );
  assert.ok(
    quoteModal.indexOf("Inclure le lien client pour consulter, accepter ou refuser") <
      quoteModal.indexOf("{attachmentLabel}"),
  );
  assert.ok(quoteModal.indexOf("{attachmentLabel}") < quoteModal.indexOf('defaultAttachmentName || "devis.pdf"'));
  assert.ok(
    invoiceModal.indexOf("Inclure le lien client pour consulter la facture") <
      invoiceModal.indexOf("{attachmentLabel}"),
  );
  assert.equal(invoiceModal.includes('aria-label="Format de pièce jointe"'), false);
  assert.equal(invoiceModal.includes('defaultAttachmentName || "document.pdf"'), false);
  assert.equal(invoiceModal.includes('showAttachmentFormat ? "facturx" : "pdf"'), true);
  assert.equal(invoiceModal.includes("La facture sera jointe en Factur-X PDF par défaut."), true);
  assert.equal(quoteModal.includes("border-t border-slate-200 bg-slate-50 px-5 py-4"), false);
  assert.equal(invoiceModal.includes("border-t border-slate-200 bg-slate-50 px-5 py-4"), false);
  assert.equal(invoicesPage.includes("reply_to: payload.reply_to"), true);
  assert.equal(invoicesPage.includes("include_link: payload.includeLink"), true);
  assert.equal(invoicesPage.includes("include_link: true"), false);
  assert.equal(invoicesPage.includes('saveDefaultStorageKey="pixfacture:invoice-email-default"'), true);
  assert.equal(invoicesPage.includes('saveDefaultStorageKey="pixfacture:invoice-followup-email-default"'), true);
  assert.equal(invoicesPage.includes("onSaveDefault={saveInvoiceEmailDefault}"), true);
  assert.equal(invoicesPage.includes("onSaveDefault={saveInvoiceFollowupDefault}"), true);
  assert.equal(quotesPage.includes('saveDefaultStorageKey="pixfacture:quote-email-default"'), true);
  assert.equal(quotesPage.includes('saveDefaultStorageKey="pixfacture:quote-followup-email-default"'), true);
  assert.equal(quotesPage.includes("onSaveDefault={saveQuoteEmailDefault}"), true);
  assert.equal(quotesPage.includes("onSaveDefault={saveQuoteFollowupDefault}"), true);
  assert.equal(invoicesPage.includes("firstDocumentContactEmail(company?.email_reply_to, accountEmail"), true);
  assert.equal(invoicesPage.includes("const openFollowupEmail = () => {"), true);
  assert.equal(invoicesPage.includes("if (trialDraftOnly)"), true);
  assert.equal(invoicesPage.includes("Message de relance"), false);
  assert.equal(invoiceRouter.includes("_document_reply_to_from_payload"), true);
  assert.equal(quoteRouter.includes("_document_reply_to_from_payload"), true);
  assert.equal(emailTemplate.includes(oldFooterContactPhrase), false);
  assert.equal(emailTemplate.includes("Contact :"), false);
  assert.equal(emailTemplate.includes("contacter l'émetteur"), false);
  assert.equal(readRepo("backend/app/services/document_email.py").includes("contacter l'émetteur"), true);
});

test("legacy info entreprise-exemple address is fully removed from active product sources", () => {
  const legacyAddress = "info" + "@example.test";
  const files = [
    "src/components/InvoiceEmailModal.tsx",
    "src/components/QuoteEmailModal.tsx",
    "src/components/EmailBodyEditor.tsx",
    "src/figma/app/pages/app/InvoicesPage.tsx",
    "src/figma/app/pages/app/QuotesPage.tsx",
    "../backend/app/templates/email/document.html",
    "../backend/app/routers/invoices.py",
    "../backend/app/routers/quotes.py",
    "../backend/app/services/document_email.py",
    "../backend/app/services/email_reply_to.py",
  ];

  for (const relativePath of files) {
    const absolutePath = path.join(__dirname, "../..", relativePath);
    assert.equal(fs.readFileSync(absolutePath, "utf8").includes(legacyAddress), false, relativePath);
  }
});
