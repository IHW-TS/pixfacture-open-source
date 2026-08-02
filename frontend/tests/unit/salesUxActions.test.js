const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");
const readRepo = (relativePath) => fs.readFileSync(path.join(__dirname, "../../..", relativePath), "utf8");

test("customer and purchase rows open from the full row without stealing interactive clicks", () => {
  const customersList = readRepo("frontend/figma-compare-srcs/pages/app/CustomersPage.tsx");
  const purchasesList = read("src/figma/app/pages/app/EinvoicingPages.tsx");

  assert.equal(customersList.includes("function isInteractiveRowTarget"), true);
  assert.equal(customersList.includes("pf-clickable-row"), true);
  assert.equal(customersList.includes("window.location.assign(`/app/customers/${customer.id}`)"), true);
  assert.equal(purchasesList.includes("function isInteractiveRowTarget"), true);
  assert.equal(purchasesList.includes("const navigate = useNavigate();"), true);
  assert.equal(purchasesList.includes("navigate(`${basePath}/${item.id}`);"), true);
  assert.equal(purchasesList.includes('role="link"'), true);
  assert.equal(purchasesList.includes("pf-clickable-row group cursor-pointer"), true);
});

test("purchase list uses row workflow and requires completed qualification for payment actions", () => {
  const purchasesList = read("src/figma/app/pages/app/EinvoicingPages.tsx");

  assert.equal(purchasesList.includes('completion !== "completed" || hasMissingSignals'), true);
  assert.equal(
    purchasesList.includes("const map: Record<string, any> = { ...(purchaseWorkflow?.items_by_invoice || {}) };"),
    true,
  );
  assert.equal(purchasesList.includes("item?.purchase_workflow"), true);
  assert.equal(purchasesList.includes("map[String(item.id)] = item.purchase_workflow;"), true);
});

test("purchase detail moves accounting readiness to header and keeps proof actions inline", () => {
  const purchasesDetail = read("src/figma/app/pages/app/EinvoicingPages.tsx");
  const sourceCardStart = purchasesDetail.indexOf('id="purchase-source-document"');
  const formStart = purchasesDetail.indexOf('id="purchase-form-main"');

  assert.notEqual(sourceCardStart, -1);
  assert.notEqual(formStart, -1);

  const sourceCard = purchasesDetail.slice(sourceCardStart, formStart);
  assert.equal(purchasesDetail.includes('data-testid="purchase-accounting-header-badge"'), true);
  assert.equal(purchasesDetail.includes("<AccountingReadinessPanel readiness={item.accounting_readiness} />"), false);
  assert.equal(purchasesDetail.includes("completionProgress"), false);
  assert.equal(purchasesDetail.includes("completionChecklist"), false);
  assert.equal(sourceCard.includes("purchaseAttachments.map"), false);
  assert.equal(sourceCard.includes("Justificatif {index + 1}"), false);
  assert.equal(sourceCard.includes("Justificatif présent"), false);
  assert.equal(sourceCard.includes('data-testid="purchase-proof-delete"'), true);
  assert.equal(sourceCard.includes('data-testid="purchase-proof-upload"'), true);
  assert.equal(sourceCard.includes('data-testid="purchase-proof-download"'), false);
  assert.match(sourceCard, /data-testid="purchase-proof-upload"[\s\S]{0,120}className="h-10"/);
  assert.match(sourceCard, /data-testid="purchase-proof-delete"[\s\S]{0,120}className="h-10"/);
  assert.equal(
    sourceCard.indexOf('data-testid="purchase-proof-delete"') >
      sourceCard.indexOf('data-testid="purchase-proof-upload"'),
    true,
  );
  assert.equal(purchasesDetail.includes("xl:items-stretch"), true);
  assert.equal(purchasesDetail.includes("xl:h-full xl:min-h-[820px]"), true);
  const accountingSectionStart = purchasesDetail.indexOf('id="purchase-accounting-section"');
  const accountingSectionEnd = purchasesDetail.indexOf("Note pour la compta", accountingSectionStart);
  const accountingSection = purchasesDetail.slice(accountingSectionStart, accountingSectionEnd);
  assert.equal(accountingSection.includes('tone="muted"'), false);
  assert.equal(accountingSection.includes("Nature de l'opération"), true);
  assert.equal(accountingSection.includes('label="Nature"'), false);
  assert.equal(accountingSection.includes("lg:grid-cols-[minmax(180px,0.54fr)_minmax(280px,1fr)_auto]"), false);
  assert.equal(accountingSection.includes("lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"), true);
  assert.equal(accountingSection.includes("lg:items-end"), false);
  assert.equal(purchasesDetail.includes("Paiement enregistré"), false);
  assert.equal(purchasesDetail.includes("inline-flex items-center rounded-full bg-[#f8fafc] px-2.5 py-1"), true);
  assert.equal(purchasesDetail.includes("S'il contient plusieurs pages"), true);
});

test("quote duplicate opens the editable draft and editor models are available for quotes", () => {
  const quoteDetail = read("src/figma/app/pages/app/QuotesPage.tsx");
  const editor = read("src/figma/app/components/app/InvoiceDocumentEditor.tsx");

  assert.equal(quoteDetail.includes("window.location.href = `/app/quotes/new?edit_quote=${result.id}`"), true);
  assert.equal(quoteDetail.includes("Copie modifiable de"), true);
  assert.equal(quoteDetail.includes("Copie modifiable créée"), true);
  assert.equal(quoteDetail.includes("Faire une copie modifiable"), true);
  assert.equal(quoteDetail.includes("Ouvrir la copie modifiable"), true);
  assert.equal(quoteDetail.includes('title="Modèle"'), false);
  assert.equal(editor.includes("canUseServerAutoFix"), false);
  assert.equal(editor.includes("Corriger automatiquement"), false);
  assert.equal(editor.includes('id: "models"'), true);
  assert.equal(editor.includes("Reprendre un devis existant"), true);
  assert.equal(editor.includes("Enregistrer ce devis comme modèle"), true);
  assert.equal(editor.includes("Enregistre le devis actuel comme modèle réutilisable."), true);
});

test("catalog picker is compact and deposit VAT accepts custom rates", () => {
  const editor = read("src/figma/app/components/app/InvoiceDocumentEditor.tsx");
  const lineCatalogMenuStart = editor.indexOf("{showLineCatalogMenu ? (");
  const firstQuickAdd = editor.indexOf("data-testid={`line-catalog-quick-add-${index + 1}`}", lineCatalogMenuStart);
  const firstSuggestionList = editor.indexOf("{lineCatalogSuggestions.length ? (", lineCatalogMenuStart);

  assert.equal(editor.includes("data-testid={`line-catalog-open-${index + 1}`}"), true);
  assert.equal(editor.includes("openCatalogManager(line.id)"), true);
  assert.equal(editor.includes("openCatalogQuickCreate(line)"), true);
  assert.equal(editor.includes("data-testid={`line-catalog-quick-add-${index + 1}`}"), true);
  assert.equal(editor.includes("Ajouter cette ligne"), true);
  assert.notEqual(lineCatalogMenuStart, -1);
  assert.notEqual(firstQuickAdd, -1);
  assert.notEqual(firstSuggestionList, -1);
  assert.equal(firstQuickAdd < firstSuggestionList, true);
  assert.equal(editor.includes("Catalogue vide"), false);
  assert.equal(editor.includes("onDoubleClick={() => {"), false);
  assert.equal(editor.includes("Ouvrir le catalogue d'articles pour cette ligne."), false);
  assert.equal(editor.includes("Voir le catalogue"), true);
  assert.equal(editor.includes("La sélection remplit la désignation, le prix, la TVA et l'unité."), false);
  assert.equal(editor.includes('data-testid="catalog-target-line-summary"'), false);
  assert.equal(editor.includes('data-testid="catalog-line-live-preview"'), false);
  assert.equal(editor.includes("catalogEditorTouched"), true);
  assert.equal(editor.includes("Repris depuis la ligne sélectionnée."), false);
  assert.equal(editor.includes('unit_code: ""'), true);
  assert.equal(editor.includes('String(catalogItemForm.unit_code || catalogPanelTargetLine?.unit_code || "")'), true);
  const catalogEditorStart = editor.indexOf('data-testid="catalog-line-live-preview"');
  const catalogEditorEnd = editor.indexOf("{catalogEditingItemId && catalogEditingItem", catalogEditorStart);
  const catalogEditorBody = editor.slice(catalogEditorStart, catalogEditorEnd);
  assert.equal(catalogEditorBody.includes("Code unité"), false);
  assert.equal(editor.includes("sm:items-center"), true);
  assert.equal(editor.includes('aria-label="Taux TVA acompte"'), false);
  assert.equal(editor.includes(`aria-label="TVA de l'acompte"`), false);
  assert.equal(editor.includes('aria-label="TVA"'), true);
  assert.equal(editor.includes("ADVANCE_VAT_RATE_OPTIONS"), true);
  assert.equal(editor.includes('<option value="custom">TVA personnalisée</option>'), true);
  assert.equal(editor.includes('aria-label="TVA personnalisée"'), true);
  assert.equal(editor.includes("pointer-events-none absolute right-2 top-1/2"), true);
  assert.equal(editor.includes("Mode de saisie de l'acompte"), true);
  assert.equal(editor.includes('<option value="5.5">5,5%</option>'), false);
  assert.equal(editor.includes('<option value="5.5">TVA 5,5%</option>'), false);
});

test("document editor supports direct company logo editing from invoice and quote canvas", () => {
  const editor = read("src/figma/app/components/app/InvoiceDocumentEditor.tsx");

  assert.equal(editor.includes('apiUpload("/api/company/logo", body)'), true);
  assert.equal(editor.includes('data-testid="invoice-logo-file-input"'), true);
  assert.equal(editor.includes('data-testid="invoice-logo-replace"'), true);
  assert.equal(editor.includes('data-testid="invoice-logo-delete"'), true);
  assert.equal(editor.includes('data-testid="invoice-logo-add"'), true);
  assert.equal(editor.includes("body: JSON.stringify({ logo_url: null })"), true);
  assert.equal(editor.includes('data-testid="invoice-logo-settings-link"'), false);
});

test("reference and product columns keep enough separation in editor and preview", () => {
  const editor = read("src/figma/app/components/app/InvoiceDocumentEditor.tsx");
  const preview = read("src/figma/app/pages/app/InvoicesPage.tsx");

  assert.equal(editor.includes('columns.push("minmax(112px,0.34fr)")'), true);
  assert.equal(editor.includes('columns.push("minmax(220px,1fr)")'), true);
  assert.equal(editor.includes("hidden gap-2 border-b"), true);
  assert.equal(preview.includes("showLineReferenceColumn ? <col style={{ width: 128 }} />"), true);
  assert.equal(preview.includes('className="whitespace-nowrap border-r border-[#dbe3ef] px-4 py-3 text-left"'), true);
  assert.equal(
    preview.includes('className="border-r border-[#e2e8f0] px-4 py-3 text-left text-[#64748b] tabular-nums"'),
    true,
  );
  assert.equal(preview.includes('letterSpacing: "0.06em"'), true);
});

test("quote issue date is read-only and no longer drives service date", () => {
  const editor = read("src/figma/app/components/app/InvoiceDocumentEditor.tsx");

  assert.equal(editor.includes('if (key === "issue_date" && !isInvoice) next.service_date = value;'), false);
  assert.equal(editor.includes("readOnly={!isInvoice}"), true);
  assert.equal(
    editor.includes("La date du devis est générée à la création. Modifiez la date de prestation si nécessaire."),
    true,
  );
  assert.equal(
    editor.includes("const applied = applyPaymentPreset(form.issue_date || form.service_date, presetId);"),
    true,
  );
});

test("document payment method wins over customer default in preview", () => {
  const preview = read("src/figma/app/pages/app/InvoicesPage.tsx");
  const paymentMethodsIndex = preview.indexOf("invoice?.template_options?.payment_methods");
  const paymentMethodIndex = preview.indexOf("invoice?.template_options?.payment_method", paymentMethodsIndex + 1);
  const legacyCustomerDefaultIndex = preview.indexOf("customer?.payment_method_default");

  assert.notEqual(paymentMethodsIndex, -1);
  assert.notEqual(paymentMethodIndex, -1);
  assert.equal(paymentMethodsIndex < paymentMethodIndex, true);
  assert.equal(legacyCustomerDefaultIndex, -1);
});

test("public quote acceptance keeps required terms visible and portal zoom defaults to 105 percent", () => {
  const publicQuote = read("src/app/(portal)/q/[token]/page.tsx");
  const customerQuote = read("src/app/(portal)/c/[token]/quotes/[quoteId]/page.tsx");
  const publicInvoice = read("src/app/(portal)/i/[token]/page.tsx");
  const portalFrame = read("src/components/PortalDocumentFrame.tsx");
  const quoteResponsePanel = read("src/app/(portal)/components/QuoteResponsePanel.tsx");

  for (const source of [publicQuote, customerQuote]) {
    assert.equal(source.includes('const DEFAULT_TERMS_URL = "/legal/cgv";'), true);
    assert.equal(source.includes("const termsHref = termsUrl || DEFAULT_TERMS_URL;"), true);
    assert.equal(source.includes("terms_accepted: termsRequired ? true : termsAccepted"), false);
    assert.equal(source.includes("terms_accepted: termsAccepted"), true);
    assert.equal(source.includes("const PORTAL_DOCUMENT_LOCKED_ZOOM = 1.05;"), true);
    assert.equal(source.includes("updateDocumentZoom"), false);
    assert.equal(source.includes("<QuoteResponsePanel"), true);
  }
  assert.equal(quoteResponsePanel.includes("conditions de vente"), true);
  assert.equal(quoteResponsePanel.includes("styles.quoteDecisionSummary"), true);
  assert.equal(quoteResponsePanel.includes("checked={termsAccepted}"), true);
  assert.equal(quoteResponsePanel.includes("onTermsAcceptedChange(event.target.checked)"), true);
  assert.equal(publicInvoice.includes("const PORTAL_DOCUMENT_LOCKED_ZOOM = 1.05;"), true);
  assert.equal(publicInvoice.includes("setDocumentZoom"), false);
  assert.equal(portalFrame.includes("const DEFAULT_DOCUMENT_ZOOM = 1.05;"), true);
});

test("public invoice share presentation is locked at 105 percent in the right document rail", () => {
  const publicInvoice = read("src/app/(portal)/i/[token]/page.tsx");
  const publicInvoiceCss = read("src/app/(portal)/i/[token]/page.module.css");

  assert.equal(publicInvoice.includes("styles.documentPresentationGrid"), true);
  assert.equal(publicInvoice.includes("styles.documentPresentationGridSolo"), true);
  assert.equal(publicInvoice.includes("styles.documentSideRail"), true);
  assert.equal(publicInvoice.includes("PORTAL_DOCUMENT_BASE_WIDTH"), true);
  assert.equal(publicInvoice.includes("PORTAL_DOCUMENT_LOCKED_ZOOM"), true);
  assert.equal(publicInvoice.includes("PIXFACTURE_BRAND_NAME"), true);
  assert.equal(publicInvoice.includes('src="/favicon.svg"'), true);
  assert.equal(publicInvoice.includes('"--public-document-visual-width"'), true);
  assert.equal(publicInvoice.includes("documentZoomToolbar"), false);
  assert.equal(publicInvoice.includes("updateDocumentZoom"), false);
  assert.equal(publicInvoice.includes("sidePanelOpen"), false);
  assert.equal(publicInvoice.includes("Options avancées"), false);
  assert.equal(publicInvoice.includes("styles.publicPresentationPanel"), true);
  assert.equal(publicInvoice.includes("styles.publicValidityCard"), true);
  assert.equal(publicInvoice.includes("Disponible jusqu'au"), true);
  assert.equal(publicInvoice.includes("styles.publicDocHeader"), false);
  assert.equal(publicInvoice.includes("styles.publicAmountTile"), false);
  assert.equal(publicInvoice.includes("styles.publicPartiesCard"), false);
  assert.equal(publicInvoice.includes("styles.publicTimelineCard"), false);
  assert.equal(publicInvoice.includes("styles.publicActionButton"), false);
  assert.equal(publicInvoice.includes("Consultation sécurisée"), false);
  assert.equal(publicInvoice.includes('role="Facturé à"'), true);
  assert.equal(publicInvoice.includes("Mention légale imprimée"), false);
  assert.equal(publicInvoice.includes(">Note<"), false);
  assert.equal(publicInvoice.includes("PORTAL_PAYMENT_UNAVAILABLE"), true);
  assert.equal(publicInvoice.includes("card_payment_enabled"), true);
  assert.equal(publicInvoice.includes("startCardPayment"), true);
  assert.equal(publicInvoice.includes("Paiement en cours de confirmation"), true);
  assert.equal(publicInvoice.includes("styles.publicSummaryRoute"), false);
  assert.equal(publicInvoice.includes("styles.publicSummaryPanel"), false);
  assert.equal(publicInvoice.includes("styles.publicMetaGrid"), false);
  assert.equal(publicInvoice.includes("styles.publicLinkPanel"), false);
  assert.equal(publicInvoice.includes("Résumé du document"), false);
  assert.equal(publicInvoice.includes("Document partagé"), false);
  assert.equal(publicInvoice.includes("className={styles.banner}"), false);
  assert.match(
    publicInvoice,
    /<aside className=\{styles\.documentSideRail\}[\s\S]*?<section className=\{styles\.publicPresentationPanel\}[\s\S]*?<div className=\{styles\.publicValidityCard\}>/,
  );
  assert.equal(
    publicInvoice.indexOf("styles.documentSideRail") < publicInvoice.indexOf("invoice.attachments?.length"),
    true,
  );
  assert.equal(
    publicInvoiceCss.includes(
      "grid-template-columns: minmax(0, var(--public-document-visual-width, 834px)) minmax(292px, 308px);",
    ),
    true,
  );
  assert.equal(publicInvoiceCss.includes("overflow-wrap: anywhere;"), true);
  assert.equal(publicInvoiceCss.includes("align-items: flex-start;"), true);
  assert.equal(publicInvoiceCss.includes("gap: 16px;"), true);
  assert.equal(publicInvoiceCss.includes(".publicPresentationPanel"), true);
  assert.equal(publicInvoiceCss.includes(".publicValidityCard"), true);
  assert.equal(publicInvoiceCss.includes(".publicDocHeader"), false);
  assert.equal(publicInvoiceCss.includes(".publicAmountTile"), false);
  assert.equal(publicInvoiceCss.includes(".publicPartiesCard"), false);
  assert.equal(publicInvoiceCss.includes(".publicTimelineCard"), false);
  assert.equal(publicInvoiceCss.includes(".publicActionButton"), false);
  assert.equal(publicInvoiceCss.includes(".legalNoticeTitle"), false);
  assert.match(publicInvoiceCss, /\.documentSideRail\s*\{[\s\S]*?padding-top: 0;/);
  assert.equal(publicInvoiceCss.includes(".publicLinkPanel"), false);
  assert.equal(publicInvoiceCss.includes(".publicSummaryPanel"), false);
  assert.equal(publicInvoiceCss.includes(".publicMetaGrid"), false);
  assert.equal(publicInvoiceCss.includes(".publicRouteFlow"), false);
  assert.equal(publicInvoiceCss.includes(".publicSummaryRoute"), false);
  assert.equal(publicInvoiceCss.includes(".documentZoomToolbar"), false);
  assert.equal(publicInvoiceCss.includes(".zoomButton"), false);
  assert.equal(publicInvoiceCss.includes("flex-direction: column;"), true);
  assert.equal(publicInvoiceCss.includes(".portalOptionsHeader"), false);
  assert.equal(publicInvoiceCss.includes(".portalPanelClose"), false);
  assert.equal(publicInvoiceCss.includes("@media (max-width: 1180px)"), true);
});

test("document editor keeps draft creation available for blank delivery address and trims VAT zeros", () => {
  const editor = read("src/figma/app/components/app/InvoiceDocumentEditor.tsx");

  assert.equal(editor.includes("function formatVatRateInputDisplay"), true);
  assert.equal(editor.includes("value={formatVatRateInputDisplay(line.vat_rate)}"), true);
  assert.equal(editor.includes("deliveryAddressDiffersForPayload"), true);
  assert.equal(
    editor.includes("Renseignez l'adresse de livraison ou décochez l'option si elle est identique à la facturation."),
    false,
  );
  assert.equal(editor.includes("Renseignez l'adresse de livraison ou décochez l'option."), false);
  assert.equal(
    editor.includes("Renseignez l'adresse de livraison si elle diffère de l'adresse de facturation."),
    false,
  );
});

test("dashboard accepted quote fallback excludes already converted quotes", () => {
  const dashboard = read("src/figma/app/pages/app/DashboardPage.tsx");

  assert.equal(dashboard.includes("function isAcceptedQuoteReadyToInvoice"), true);
  assert.equal(dashboard.includes('String(item?.status || "").toLowerCase() !== "accepted"'), true);
  assert.equal(dashboard.includes("item?.invoice_id || item?.invoiceId"), true);
  assert.equal(dashboard.includes("amountForAcceptedQuotesReadyToInvoice(quotes)"), true);
  assert.equal(dashboard.includes('amountForStatus(quotes, ["accepted"])'), false);
});

test("credit note modal keeps API quantity payload while adding partial amount controls", () => {
  const modal = read("src/components/CreditNoteModal.tsx");
  const invoiceDetail = read("src/figma/app/pages/app/InvoicesPage.tsx");

  assert.equal(modal.includes("Aperçu de la facture source"), false);
  assert.equal(modal.includes("Document à créditer"), false);
  assert.equal(modal.includes("Document d'origine"), false);
  assert.equal(modal.includes("Facture source"), true);
  assert.equal(modal.includes("Montant TTC à créditer"), true);
  assert.equal(modal.includes("Avoir 50 %"), true);
  assert.equal(modal.includes("Un avoir peut être total ou partiel."), false);
  assert.equal(modal.includes("setLineCreditAmount"), true);
  assert.equal(modal.includes("formatAmountInput(l.ttc)"), true);
  assert.equal(modal.includes("selectedPreviewLines"), false);
  assert.equal(modal.includes("Le total d'avoir correspond au montant net crédité, remises incluses."), false);
  assert.equal(modal.includes("formatMoney(totals.ttc, resolvedCurrency)"), true);
  assert.equal(modal.includes("onSubmit({"), true);
  assert.equal(modal.includes("lines: selectedLines"), true);
  assert.equal(invoiceDetail.includes('currency={invoice?.currency || "EUR"}'), true);
  assert.equal(invoiceDetail.includes("related_invoice_number"), true);
  assert.equal(invoiceDetail.includes("Avoirs liés"), true);
});

test("invoice list can filter invoices versus credit notes and date focus stays neutral", () => {
  const invoicesList = readRepo("frontend/figma-compare-srcs/pages/app/InvoicesPage.tsx");
  const styles = read("src/figma/styles/index-next.css");

  assert.equal(invoicesList.includes('type InvoiceDocumentTypeFilter = "all" | "invoice" | "credit_note";'), true);
  assert.equal(invoicesList.includes("invoiceDocumentTypeOptions"), true);
  assert.equal(invoicesList.includes("Factures"), true);
  assert.equal(invoicesList.includes("Avoirs"), true);
  assert.equal(invoicesList.includes("document:invoice"), true);
  assert.equal(invoicesList.includes("document:credit_note"), true);
  assert.equal(invoicesList.includes("Filtrer par type de document"), false);
  assert.equal(invoicesList.includes('params.set("document_type", documentTypeFilter)'), true);
  assert.equal(styles.includes('.figma-root .pf-filter-button input[type="month"]:focus'), true);
  assert.equal(styles.includes("box-shadow: none !important"), true);
});

test("billing page does not expose the payment provider in user-facing subscription copy", () => {
  const billing = read("src/figma/app/pages/app/BillingPage.tsx");

  assert.equal(billing.includes("Facturation via Stripe"), false);
  assert.equal(billing.includes("via Stripe"), false);
  assert.equal(billing.includes("Débité directement via Stripe"), false);
  assert.equal(billing.includes("Portail Stripe indisponible"), false);
  assert.equal(billing.includes("Impossible d'ouvrir la facturation Stripe"), false);
});

test("billing trial copy protects real Seqino token usage", () => {
  const billing = read("src/figma/app/pages/app/BillingPage.tsx");

  assert.equal(
    billing.includes("L’essai Pro de ${TRIAL_DAYS} jours est limité aux brouillons et prévisualisations"),
    true,
  );
  assert.equal(
    billing.includes("la transmission reste soumise au contrat, au mandat et à la configuration du connecteur"),
    true,
  );
  assert.equal(billing.includes("aucun email client"), true);
  assert.equal(billing.includes("les 50 jetons sont réservés puis crédités une seule fois"), true);
  assert.equal(billing.includes("disponibilité du stock"), true);
  assert.equal(billing.includes("connecteur opérationnel"), true);
});

test("Pro checkout unavailability and deferred token bonus stay explicit in every active sales surface", () => {
  const pricing = read("src/app/(marketing)/pricing/PricingClientPage.tsx");
  const landingPricing = read("src/figma/app/components/landing/Pricing.tsx");
  const billing = read("src/figma/app/pages/app/BillingPage.tsx");

  assert.match(pricing, /checkoutState\.message/);
  assert.match(pricing, /pricing-arc-plan__availability/);
  assert.match(billing, /selectedCheckout\.message/);
  assert.match(billing, /pro_welcome_stock_unavailable/);
  for (const source of [pricing, landingPricing, billing]) {
    assert.match(source, /réservés/);
    assert.match(source, /disponibilité du stock/);
  }
  assert.match(landingPricing, /ctaHref: "\/pricing"/);
});

test("landing keeps the core decision journey without redundant technical sections", () => {
  const landing = read("src/figma/app/pages/LandingPage.tsx");

  for (const section of ["ProblemSolution", "Features", "HowItWorks", "Security", "Pricing", "ReformTimeline", "FAQ"]) {
    assert.match(landing, new RegExp(`<${section} \\/>`));
  }
  assert.doesNotMatch(landing, /TechBand|ProductOverview/);
});

test("Pro trial can subscribe without support-only plan change routing", () => {
  const billing = read("src/figma/app/pages/app/BillingPage.tsx");

  assert.equal(
    billing.includes('normalizedSubscriptionStatus === "active" && currentPlan && !isCurrentPlan && !isEnterprise'),
    true,
  );
  assert.equal(billing.includes("currentSubscriptionActive && currentPlan && !isCurrentPlan && !isEnterprise"), false);
  assert.match(billing, /const isTrialActivation = subscriptionTrialing && isCurrentPlan && !isEnterprise/);
  assert.match(billing, /isTrialActivation\s*\? `Activer \$\{planItem\.name\}`/);
  assert.match(billing, /\(!isTrialActivation && isCurrentPlan\)/);
});

test("dashboard no longer shows financial health status and token cards", () => {
  const dashboard = read("src/figma/app/pages/app/DashboardPage.tsx");

  assert.equal(dashboard.includes('SectionHeader title="Santé financière"'), false);
  assert.equal(dashboard.includes('ChartCard title="Statuts factures"'), false);
  assert.equal(dashboard.includes("Jetons de transmission"), false);
  assert.equal(dashboard.includes("/api/tokens/balance?history_limit=1"), false);
});

test("app headers only keep the settings breadcrumb category", () => {
  const header = read("src/figma/app/components/app/AppPageHeader.tsx");

  assert.equal(header.includes('normalizedSectionLabel === "parametres"'), true);
  assert.equal(
    header.includes(
      "const currentLabel = sectionLabel ? breadcrumbParts[breadcrumbParts.length - 1] || title : title;",
    ),
    true,
  );
});

test("company and customer detail use primary edit buttons and aligned side summaries", () => {
  const company = read("src/figma/app/pages/app/CompanyPage.tsx");
  const customers = read("src/figma/app/pages/app/CustomersPage.tsx");
  const companyHeader = company.slice(
    company.indexOf('title="Mon entreprise"'),
    company.indexOf("CompanyPreviewSidebar"),
  );
  const customerHeaderStart = customers.indexOf("title={customer?.name");
  const customerHeader = customers.slice(
    customerHeaderStart,
    customers.indexOf("<CustomerFormFields", customerHeaderStart),
  );
  const customerSidebar = customers.slice(
    customers.indexOf("function CustomerDetailSidebar"),
    customers.indexOf("function CustomerSupplierMergeModal"),
  );

  assert.equal(company.includes("Aperçu entreprise"), false);
  assert.match(
    companyHeader,
    /<PrimaryButton onClick=\{\(\) => setEditing\(true\)\} disabled=\{loading\}>[\s\S]*Modifier[\s\S]*<\/PrimaryButton>/,
  );
  assert.match(
    customerHeader,
    /<PrimaryButton onClick=\{\(\) => setEditing\(true\)\}>[\s\S]*Modifier[\s\S]*<\/PrimaryButton>/,
  );
  assert.equal(customerSidebar.includes("Client\n        </div>"), false);
  assert.equal(customerSidebar.includes('label="Profil" value={`${readiness.score}%`}'), true);
  assert.equal(customerSidebar.includes('title="Préparation"'), true);
  assert.equal(customerSidebar.includes('title="Paiement" icon={ReceiptText} tone="amber"'), true);
  assert.equal(customerSidebar.includes('title="Historique"'), false);
  assert.equal(customerSidebar.includes("Note interne"), false);
  assert.equal(customerSidebar.includes("api(`/api/customers/${customerId}`"), false);
  assert.equal(customerSidebar.includes("bg-[#eff6ff]/60 text-[#1d4ed8]"), true);
});

test("get started page uses a guided two-column onboarding layout", () => {
  const misc = read("src/figma/app/pages/app/MiscPages.tsx");
  const page = misc.slice(
    misc.indexOf("export function GetStartedPage"),
    misc.indexOf("export function OnboardingPage"),
  );

  assert.equal(page.includes("xl:grid-cols-[minmax(0,1fr)_360px]"), true);
  assert.equal(page.includes("Parcours essentiel"), false);
  assert.equal(page.includes("Votre base de facturation est prête"), false);
  assert.equal(page.includes("Prochaine action"), false);
  assert.equal(page.includes("Aucune action prioritaire"), false);
  assert.equal(page.includes("summary?.next_actions?.[0]"), false);
  assert.equal(page.includes('key !== "platforms" && key !== "mandates"'), false);
  assert.equal(page.includes("Brancher une plateforme"), false);
  assert.equal(page.includes("pb-8 pt-5"), true);
  assert.equal(page.includes("md:grid-cols-3"), false);
});

test("onboarding keeps trial access open when checkout was requested", () => {
  const misc = read("src/figma/app/pages/app/MiscPages.tsx");
  const page = misc.slice(misc.indexOf("export function OnboardingPage"), misc.indexOf("export function CompanyPage"));

  assert.equal(page.includes("const subscriptionReady = subscriptionActive;"), true);
  assert.equal(page.includes("subscriptionActive && !checkoutRequested"), false);
  assert.equal(page.includes("billingFollowupRequested"), true);
  assert.equal(page.includes("Finaliser le plan"), true);
});

test("import export actions sit in the requested header and export rows", () => {
  const customersList = readRepo("frontend/figma-compare-srcs/pages/app/CustomersPage.tsx");
  const cashPage = read("src/figma/app/pages/app/CashPage.tsx");
  const purchases = read("src/figma/app/pages/app/EinvoicingPages.tsx");
  const invoicesList = readRepo("frontend/figma-compare-srcs/pages/app/InvoicesPage.tsx");
  const quotesList = readRepo("frontend/figma-compare-srcs/pages/app/QuotesPage.tsx");
  const salesLayout = read("src/figma/app/components/app/SalesModuleLayout.tsx");
  const appHeader = read("src/figma/app/components/app/AppPageHeader.tsx");

  const customersHeader = customersList.slice(
    customersList.indexOf("<AppPageHeader"),
    customersList.indexOf("<WorkbenchPage"),
  );
  const customersToolbar = customersList.slice(
    customersList.indexOf("<SalesListBlock"),
    customersList.indexOf("{loading", customersList.indexOf("<SalesListBlock")),
  );
  assert.equal(customersHeader.includes('label="Outils"'), false);
  assert.equal(customersHeader.includes('label="Importer/Exporter"'), false);
  assert.equal(customersHeader.includes("Portefeuille client"), true);
  assert.equal(customersHeader.includes("Créer un client"), true);
  assert.equal(customersHeader.includes("Importer"), false);
  assert.equal(customersHeader.includes("Exporter"), false);
  assert.equal(customersList.includes("customerExportToolsOpen"), true);
  assert.equal(customersList.includes("triggerIcon={Settings}"), true);
  assert.equal(customersList.includes("Clients filtrés · {filtered.length}"), true);
  assert.equal(customersList.includes("Clients cochés · {selectedCustomers.length}"), true);
  assert.equal(customersToolbar.includes('searchPlaceholder="Nom, email, SIRET, TVA..."'), true);
  assert.equal(customersToolbar.includes("leftExtras={"), true);
  assert.equal(customersToolbar.includes('triggerVariant="orange"'), true);
  assert.equal(customersToolbar.includes('label="Importer / exporter"'), true);
  assert.equal(customersToolbar.includes("Importer CSV"), true);
  assert.equal(customersToolbar.includes('label: "Exporter"'), true);
  assert.equal(customersToolbar.includes("Vérifier les doublons"), true);
  assert.equal(customersToolbar.includes("Actions (${selectedCustomers.length})"), false);
  assert.equal(customersToolbar.includes('<ActionMenu label="Outils" items={toolItems} />'), false);

  const cashHeader = cashPage.slice(cashPage.indexOf("<AppPageHeader"), cashPage.indexOf("<WorkbenchPage"));
  const cashToolbar = cashPage.slice(
    cashPage.indexOf("<SalesListBlock"),
    cashPage.indexOf("{showAdvancedFilters", cashPage.indexOf("<SalesListBlock")),
  );
  assert.equal(cashHeader.includes('label="Actions"'), false);
  assert.equal(cashHeader.includes('label="Importer/Exporter"'), false);
  assert.equal(cashHeader.includes("Importer"), false);
  assert.equal(cashHeader.includes("Exporter"), false);
  assert.equal(cashHeader.includes("Exporter les recettes filtrées"), false);
  assert.equal(cashPage.includes("cashExportToolsOpen"), true);
  assert.equal(cashPage.includes('label="Importer / exporter"'), true);
  assert.equal(cashPage.includes("Importer CSV"), true);
  assert.equal(cashPage.includes("Exporter"), true);
  assert.equal(cashPage.includes("Vue filtrée · {filteredMovements.length}"), true);
  assert.equal(cashPage.includes("Sélection · {selectedMovements.length}"), true);
  assert.equal(cashToolbar.includes("leftExtras={"), true);
  assert.equal(cashToolbar.includes('label="Actions"'), true);
  assert.equal(cashToolbar.includes('triggerVariant="orange"'), true);
  assert.equal(cashToolbar.includes("badge={selectedMovements.length}"), true);
  assert.equal(cashToolbar.includes("Actions (${selectedMovements.length})"), false);
  assert.equal(cashToolbar.includes('tone="payments"'), true);
  assert.equal(cashToolbar.includes("{selectedMovementCount} sélectionné"), false);
  assert.equal(salesLayout.includes('"--pf-module-soft": theme.soft'), true);
  assert.equal(salesLayout.includes('"--pf-module-strong": theme.strong'), true);
  assert.equal(salesLayout.includes('"--pf-module-border": theme.border'), true);
  assert.equal(appHeader.includes('background: "#5B5EF4"'), true);
  assert.equal(appHeader.includes('background: "#7c3aed"'), true);
  assert.equal(appHeader.includes('background: "#f97316"'), true);
  assert.equal(appHeader.includes("linear-gradient(135deg,#2563eb"), false);
  assert.equal(appHeader.includes("linear-gradient(135deg,#7c3aed"), false);
  assert.equal(appHeader.includes("linear-gradient(135deg,#f97316"), false);

  const purchaseToolbar = purchases.slice(
    purchases.indexOf('searchPlaceholder="Fournisseur, facture, SIREN..."'),
    purchases.indexOf("{showFilters ? (", purchases.indexOf('searchPlaceholder="Fournisseur, facture, SIREN..."')),
  );
  const purchaseHeader = purchases.slice(
    purchases.indexOf("const purchaseHeaderActions"),
    purchases.indexOf("useEffect(() => {", purchases.indexOf("const purchaseHeaderActions")),
  );
  assert.equal(purchases.includes('label="Fichiers" triggerVariant="success"'), false);
  assert.equal(purchases.includes('data-testid="purchase-action-references"'), true);
  assert.equal(purchases.includes('label="Dépense manuelle" triggerVariant="success"'), false);
  assert.equal(purchases.includes('label="Ajouter une dépense" triggerVariant="success"'), true);
  assert.equal(purchaseHeader.includes("Importer facture"), false);
  assert.equal(purchaseHeader.includes('data-testid="purchase-export-csv"'), false);
  assert.equal(purchaseHeader.includes("pixfacture:purchases-export-panel"), false);
  assert.equal(
    purchaseHeader.indexOf('data-testid="purchase-action-references"') <
      purchaseHeader.indexOf('label="Ajouter une dépense"'),
    true,
  );
  assert.equal(purchases.includes('label="Importer / exporter"'), true);
  assert.equal(purchaseToolbar.includes("Importer une facture"), true);
  assert.equal(purchaseToolbar.includes("Exporter"), true);
  assert.equal(purchaseToolbar.includes("leftExtras={"), true);
  assert.equal(purchaseToolbar.includes('triggerVariant="success"'), true);
  assert.equal(purchaseToolbar.includes('label="Actions"'), true);
  assert.equal(purchaseToolbar.includes("badge={selectedPurchaseCount}"), true);
  assert.equal(purchaseToolbar.includes("Actions (${selectedPurchaseCount})"), false);
  assert.equal(purchaseToolbar.includes('data-testid="purchase-export-csv"'), false);
  assert.equal(purchaseToolbar.includes("Filtres"), false);
  assert.equal(purchaseToolbar.includes("Désélectionner {selectedPurchaseCount}"), false);
  assert.equal(purchases.includes("purchaseExportToolsOpen"), true);
  assert.equal(purchases.includes('downloadPurchasesExport("csv", "filtered")'), true);
  assert.equal(purchases.includes('downloadPurchasesExport("csv", "selection")'), true);
  assert.equal(purchases.includes('fontSize: "var(--pf-app-table-header)"'), true);

  const invoiceHeader = invoicesList.slice(
    invoicesList.indexOf("<AppPageHeader"),
    invoicesList.indexOf("<WorkbenchPage"),
  );
  const invoiceToolbar = invoicesList.slice(
    invoicesList.indexOf("<SalesListBlock"),
    invoicesList.indexOf("{exportToolsOpen ? (", invoicesList.indexOf("<SalesListBlock")),
  );
  assert.equal(invoiceHeader.includes('aria-label="Exporter les factures"'), false);
  assert.equal(invoiceHeader.includes("Créer une facture"), true);
  assert.equal(invoiceToolbar.includes('aria-label="Exporter les factures"'), true);
  assert.equal(invoiceToolbar.includes('<Download className="w-3.5 h-3.5" /> Exporter'), false);
  assert.equal(invoiceToolbar.includes("Exporter la vue"), false);
  assert.equal(invoiceToolbar.includes("leftExtras={"), true);
  assert.equal(invoiceToolbar.includes('triggerVariant="primary"'), true);
  assert.equal(invoiceToolbar.includes('label="Actions"'), true);
  assert.equal(invoiceToolbar.includes("badge={selectedInvoiceCount}"), true);
  assert.equal(invoiceToolbar.includes("Actions (${selectedInvoiceCount})"), false);
  assert.equal(invoicesList.includes("{selectedInvoiceCount} sélectionnée"), false);
  assert.equal(invoicesList.includes('data-testid="invoice-export-panel"'), true);
  assert.equal(invoicesList.includes("bg-gradient-to-br from-[#eff6ff] via-white to-[#f8fbff]"), false);
  assert.equal(invoicesList.includes('className="border-b border-[#dbeafe] bg-[#eff6ff] p-3"'), true);

  const quoteHeader = quotesList.slice(quotesList.indexOf("<AppPageHeader"), quotesList.indexOf("<WorkbenchPage"));
  const quoteToolbar = quotesList.slice(
    quotesList.indexOf("<SalesListBlock"),
    quotesList.indexOf("{advancedFiltersOpen ? (", quotesList.indexOf("<SalesListBlock")),
  );
  assert.equal(quoteHeader.includes('aria-label="Exporter les devis"'), false);
  assert.equal(quoteHeader.includes("Créer un devis"), true);
  assert.equal(quotesList.includes('aria-label="Exporter les devis"'), true);
  assert.equal(quoteToolbar.includes('label="Exporter" triggerVariant="purple"'), false);
  assert.equal(quoteToolbar.includes("leftExtras={"), true);
  assert.equal(quoteToolbar.includes('triggerVariant="purple"'), true);
  assert.equal(quoteToolbar.includes('label="Actions"'), true);
  assert.equal(quoteToolbar.includes("badge={selectedQuoteCount}"), true);
  assert.equal(quoteToolbar.includes("Actions (${selectedQuoteCount})"), false);
  assert.equal(quotesList.includes("{selectedQuoteCount} sélectionné"), false);
  assert.equal(quotesList.includes('data-testid="quote-export-panel"'), true);
  assert.equal(quotesList.includes('className="border-b border-[#ddd6fe] bg-[#f5f3ff] px-4 py-3"'), true);
  assert.equal(quotesList.includes("PDF devis"), true);
  assert.equal(quotesList.includes("Devis filtrés ·"), true);
  assert.equal(quotesList.includes("Devis cochés ·"), true);
});

test("temporary notices can auto-dismiss and be manually closed", () => {
  const compareHeader = readRepo("frontend/figma-compare-srcs/components/app/AppPageHeader.tsx");
  const feedback = read("src/figma/app/components/app/Feedback.tsx");
  const cashPage = read("src/figma/app/pages/app/CashPage.tsx");
  const purchases = read("src/figma/app/pages/app/EinvoicingPages.tsx");

  assert.equal(compareHeader.includes("autoDismissMs?: number"), true);
  assert.equal(compareHeader.includes("window.setTimeout(onDismiss, autoDismissMs)"), true);
  assert.equal(compareHeader.includes('aria-label="Fermer le message"'), true);
  assert.equal(feedback.includes("autoDismissMs?: number"), true);
  assert.equal(feedback.includes("window.setTimeout(onDismiss, autoDismissMs)"), true);
  assert.equal(feedback.includes('aria-label="Fermer le message"'), true);
  assert.equal(
    cashPage.includes('<NoticeBanner tone="info" onDismiss={() => setNotice(null)} autoDismissMs={6000}>'),
    true,
  );
  assert.equal(
    purchases.includes('<NoticeBanner tone="success" onDismiss={() => setNotice(null)} autoDismissMs={6000}>'),
    true,
  );
});

test("table headers expose a visible filter-sort affordance", () => {
  const compareHeader = readRepo("frontend/figma-compare-srcs/components/app/AppPageHeader.tsx");
  const activeHeader = read("src/figma/app/components/app/AppPageHeader.tsx");
  const customersList = readRepo("frontend/figma-compare-srcs/pages/app/CustomersPage.tsx");
  const invoicesList = readRepo("frontend/figma-compare-srcs/pages/app/InvoicesPage.tsx");
  const quotesList = readRepo("frontend/figma-compare-srcs/pages/app/QuotesPage.tsx");
  const cashPage = read("src/figma/app/pages/app/CashPage.tsx");
  const styles = read("src/figma/styles/index-next.css");

  assert.equal(compareHeader.includes("function DataTableHeaderLabel"), true);
  assert.equal(compareHeader.includes("onClick={() => toggleSort(i)}"), true);
  assert.equal(compareHeader.includes("aria-label={`Trier par ${children}`}"), true);
  assert.equal(compareHeader.includes('active ? "pf-sort-header-active text-[#ea580c]" : ""'), true);
  assert.equal(activeHeader.includes("onClick={() => toggleSort(index)}"), true);
  assert.equal(activeHeader.includes("aria-label={`Trier par ${header}`}"), true);
  assert.equal(activeHeader.includes('sortState?.index === index ? "pf-sort-header-active text-[#ea580c]" : ""'), true);
  assert.equal(customersList.includes("ArrowUpDown"), true);
  assert.equal(customersList.includes("ArrowUp"), true);
  assert.equal(customersList.includes("ArrowDown"), true);
  assert.equal(customersList.includes("aria-pressed={isActive}"), true);
  assert.equal(customersList.includes('isActive ? "pf-sort-header-active text-[#ea580c]" : ""'), true);
  assert.equal(customersList.includes('fontSize: "inherit"'), true);
  assert.equal(customersList.includes('fontWeight: "inherit"'), true);
  assert.equal(customersList.includes('textTransform: "inherit"'), true);
  assert.equal(invoicesList.includes("function InvoiceColumnHeader"), true);
  assert.equal(invoicesList.includes('sortKey="total_ttc"'), true);
  assert.equal(invoicesList.includes("onSort={toggleSort}"), true);
  assert.equal(
    invoicesList.includes('active ? "pf-sort-header-active pf-sort-header-invoices text-[#2563eb]" : ""'),
    true,
  );
  assert.equal(quotesList.includes("function QuoteColumnHeader"), true);
  assert.equal(quotesList.includes('sortKey="total_ttc"'), true);
  assert.equal(quotesList.includes("onSort={toggleSort}"), true);
  assert.equal(quotesList.includes('active ? "pf-sort-header-active pf-sort-header-quotes text-[#7c3aed]" : ""'), true);
  assert.equal(cashPage.includes("function CashTableHeader"), true);
  assert.equal(cashPage.includes("aria-label={`Trier par ${children}`}"), true);
  assert.equal(cashPage.includes('sortKey="movement"'), true);
  assert.equal(cashPage.includes('key: "amount"'), true);
  assert.equal(cashPage.includes("sortKey={column.key}"), true);
  assert.equal(cashPage.includes("compareCashMovements"), true);
  assert.equal(cashPage.includes('active ? "pf-sort-header-active" : ""'), true);
  assert.equal(cashPage.includes("Remboursement avoir"), true);
  assert.equal(cashPage.includes("Achats et remboursements réglés"), true);
  assert.equal(cashPage.includes('kind: amount >= 0 ? "incoming" : "outgoing"'), true);
  assert.equal(cashPage.includes("pf-cash-amount-positive"), true);
  assert.equal(cashPage.includes("pf-cash-amount-negative"), true);
  assert.equal(styles.includes("td.pf-cash-amount-positive"), true);
  assert.equal(styles.includes("td.pf-cash-amount-negative"), true);
  assert.equal(styles.includes(".figma-root .pf-data-table thead th button,"), true);
  assert.equal(styles.includes("--pf-app-table-header: 0.75rem;"), true);
  assert.equal(styles.includes("font-size: var(--pf-app-table-header) !important;"), true);
  assert.equal(styles.includes(".figma-root .pf-data-list-header > div button,"), true);
  assert.equal(styles.includes("min-width: 1rem !important;"), true);
  assert.equal(styles.includes(".figma-root .pf-sort-header-active"), true);
  assert.equal(styles.includes(".figma-root .pf-sort-header-quotes"), true);
  assert.equal(styles.includes(".figma-root .pf-sort-header-invoices"), true);
  assert.equal(styles.includes(".figma-root .pf-sort-header-purchases"), true);
  assert.equal(styles.includes(".figma-root .pf-sort-header-orange"), true);
  assert.equal(styles.includes(".figma-root .pf-purchases-table"), true);
});

test("company page hides legal mentions from the visible company form but keeps API compatibility", () => {
  const company = read("src/figma/app/pages/app/CompanyPage.tsx");

  assert.equal(company.includes("xl:grid-cols-[minmax(0,1fr)_320px]"), true);
  assert.equal(company.includes('aria-label="Rechercher une entreprise par SIREN ou SIRET"'), true);
  assert.equal(company.includes(">Recherche entreprise<"), false);
  assert.equal(company.includes("Remplacer"), false);
  assert.equal(company.includes('title="Mentions légales"'), false);
  assert.equal(company.includes("applyLegalDefaults"), false);
  assert.equal(company.includes("legal_mentions: form.legal_mentions.trim() || null"), true);
  assert.equal(company.includes("profile.legal_mentions ||"), true);
  assert.equal(company.includes("form.vat_exemption_notice.trim() || /293"), false);
});

test("document editor separates invoice and quote printed legal mention templates", () => {
  const editor = read("src/figma/app/components/app/InvoiceDocumentEditor.tsx");

  assert.equal(editor.includes('type DocumentLegalTemplateKind = "invoice" | "quote";'), true);
  assert.equal(editor.includes("document_legal_templates"), true);
  assert.equal(editor.includes("getDocumentLegalTemplate(tenantFeatures, documentLegalTemplateKind)"), true);
  assert.equal(editor.includes("applyDocumentLegalTemplateToForm("), true);
  assert.equal(editor.includes("Enregistrer cette mention pour les prochains documents"), true);
  assert.equal(editor.includes("Modèle de mention facture enregistré pour les prochaines factures."), true);
  assert.equal(editor.includes("Modèle de mention devis enregistré pour les prochains devis."), true);
  assert.equal(editor.includes("Revenir au texte par défaut"), true);
  assert.equal(editor.includes("absolute right-0 top-full"), true);
  assert.equal(editor.includes("{documentCopy.default}"), false);
  assert.equal(editor.includes("Recalcule la mention selon le type de document, la TVA et les conditions."), false);
  assert.equal(editor.includes("Modèle séparé pour"), false);
});

test("company completion no longer requires hidden legal mentions", () => {
  const editor = read("src/figma/app/components/app/InvoiceDocumentEditor.tsx");
  const quoteDetail = read("src/figma/app/pages/app/QuotesPage.tsx");

  assert.equal(editor.includes('? "mentions légales"'), false);
  assert.equal(quoteDetail.includes('? "mentions légales"'), false);
  assert.equal(editor.includes('legal_mentions_text: ""'), true);
  assert.equal(editor.includes("Mention légale imprimée"), true);
});

test("document status tabs and CRM duplicate controls stay explicit", () => {
  const invoicesList = readRepo("frontend/figma-compare-srcs/pages/app/InvoicesPage.tsx");
  const legacyInvoices = read("src/figma/app/pages/app/InvoicesPage.tsx");
  const quotesList = readRepo("frontend/figma-compare-srcs/pages/app/QuotesPage.tsx");
  const customersList = readRepo("frontend/figma-compare-srcs/pages/app/CustomersPage.tsx");
  const customerForm = read("src/figma/app/pages/app/CustomersPage.tsx");
  const company = read("src/figma/app/pages/app/CompanyPage.tsx");
  const companyCompare = readRepo("frontend/figma-compare-srcs/pages/app/CompanyPage.tsx");

  assert.equal(invoicesList.includes('label: "En attente"'), true);
  assert.equal(invoicesList.includes('item.val === "overdue"'), true);
  assert.equal(legacyInvoices.includes('{ value: "pending", label: "En attente" }'), true);
  assert.equal(quotesList.includes('val: "rejected"'), true);
  assert.equal(quotesList.includes('label: "Refusés"'), true);
  assert.equal(customersList.includes('aria-label="Fermer le panneau des doublons"'), true);
  assert.equal(customersList.includes("Masquer"), false);
  assert.equal(customerForm.includes("focus-within:border-[#93c5fd]"), false);
  assert.equal(company.includes("focus-within:border-[#93c5fd]"), false);
  assert.equal(companyCompare.includes("focus-within:border-[#93c5fd]"), false);
  assert.equal(customerForm.includes("focus:ring-0 focus:shadow-none"), true);
  assert.equal(company.includes("focus:ring-0 focus:shadow-none"), true);
  assert.equal(companyCompare.includes("focus:ring-0 focus:shadow-none"), true);
});

test("export tooltips and metric cards stay simple and non-filtering", () => {
  const invoicesList = readRepo("frontend/figma-compare-srcs/pages/app/InvoicesPage.tsx");
  const cashPage = read("src/figma/app/pages/app/CashPage.tsx");
  const guidanceTooltip = read("src/figma/app/components/app/GuidanceTooltip.tsx");
  const salesLayout = read("src/figma/app/components/app/SalesModuleLayout.tsx");
  const company = read("src/figma/app/pages/app/CompanyPage.tsx");
  const companyCompare = readRepo("frontend/figma-compare-srcs/pages/app/CompanyPage.tsx");
  const customers = read("src/figma/app/pages/app/CustomersPage.tsx");

  assert.equal(invoicesList.includes("applyMetricCardFilter"), false);
  assert.equal(invoicesList.includes('title="Exporte les factures correspondant aux filtres affichés'), false);
  assert.equal(guidanceTooltip.includes('title={typeof content === "string" ? content : undefined}'), false);
  assert.equal(salesLayout.includes('!disabled ? "hover:-translate-y-[1px]" : ""'), true);

  const invoiceMetricsStart = invoicesList.indexOf("<SalesMetricsGrid>");
  const invoiceMetricsEnd = invoicesList.indexOf("</SalesMetricsGrid>", invoiceMetricsStart);
  const invoiceMetrics = invoicesList.slice(invoiceMetricsStart, invoiceMetricsEnd);
  assert.equal(invoiceMetrics.includes("onClick="), false);
  assert.equal(invoiceMetrics.includes("ariaLabel="), false);

  const cashMetricsStart = cashPage.indexOf("<SalesMetricsGrid>");
  const cashMetricsEnd = cashPage.indexOf("</SalesMetricsGrid>", cashMetricsStart);
  const cashMetrics = cashPage.slice(cashMetricsStart, cashMetricsEnd);
  assert.equal(cashMetrics.includes("onClick={() => setViewFilter"), false);
  assert.equal(cashMetrics.includes("ariaLabel="), false);
  assert.equal(cashPage.includes('title="Exporte les mouvements affichés avec la période'), false);
  assert.equal(cashPage.includes('title="Exporte uniquement les encaissements'), false);
  assert.equal(cashPage.includes("Filtres avancés"), false);
  assert.equal(cashPage.includes("Actualiser les données"), false);
  assert.equal(cashPage.includes("Réinitialiser la vue"), false);
  const cashHeader = cashPage.slice(cashPage.indexOf("<AppPageHeader"), cashPage.indexOf("<WorkbenchPage"));
  assert.equal(cashHeader.includes('label="Actions" triggerVariant="orange"'), false);
  assert.equal(cashPage.includes('label="Importer/Exporter" triggerVariant="orange"'), false);
  assert.equal(cashPage.includes("cashExportToolsOpen"), true);
  assert.equal(cashPage.includes("Synthèse trésorerie"), false);
  assert.equal(cashPage.includes("Période · {activePeriodDetail}"), false);
  assert.equal(cashPage.includes("Estimation interne à partir des ventes et achats saisis."), false);
  assert.equal(cashPage.includes("grid gap-3 lg:gap-4 md:grid-cols-2 xl:grid-cols-4"), true);
  const vatCardStart = cashPage.indexOf("TVA estimée");
  const vatCardEnd = cashPage.indexOf("{importRows.length > 0 ? (", vatCardStart);
  const vatCard = cashPage.slice(vatCardStart, vatCardEnd);
  assert.equal(vatCard.includes("duration-500"), false);
  assert.equal(vatCard.includes("bg-emerald-400"), false);
  assert.equal(vatCard.includes("bg-indigo-400"), false);

  assert.equal(company.includes("focus-within:ring-2 focus-within:ring-[#1d4ed8]/15"), false);
  assert.equal(companyCompare.includes("focus-within:ring-2 focus-within:ring-[#1d4ed8]/15"), false);
  assert.equal(customers.includes("focus-within:ring-2 focus-within:ring-[#1d4ed8]/15"), false);
});

test("company and customer forms hide redundant business type and free address fields", () => {
  const company = read("src/figma/app/pages/app/CompanyPage.tsx");
  const customers = read("src/figma/app/pages/app/CustomersPage.tsx");

  assert.equal(company.includes("Type d'entreprise"), false);
  assert.equal(company.includes("Adresse libre"), false);
  assert.equal(company.includes("VAT_FRANCHISE_NOTICE"), true);
  assert.equal(company.includes("vat_on_debits: isVatFranchiseRegime(form.vat_regime) ? false"), true);
  assert.equal(customers.includes("Adresse libre"), false);
  assert.equal(customers.includes("composeStructuredCustomerAddress"), true);
  assert.equal(customers.includes("address: orNull(structuredAddress || form.address)"), true);
  assert.equal(customers.includes("Adresse ligne 1 et ville."), true);
});

test("document editor locks VAT to zero for companies in VAT franchise", () => {
  const editor = read("src/figma/app/components/app/InvoiceDocumentEditor.tsx");

  assert.equal(editor.includes("VAT_FRANCHISE_REASON_CODE"), true);
  assert.equal(editor.includes("VAT_FRANCHISE_GLOBAL_DRAFT"), true);
  assert.equal(editor.includes("function isVatFranchiseRegime"), true);
  assert.equal(editor.includes("isCompanyVatFranchise(company)"), true);
  assert.equal(editor.includes("const companyVatFranchise = isCompanyVatFranchise(company);"), true);
  assert.equal(editor.includes("lines.map(franchiseVatLine)"), true);
  assert.equal(editor.includes("Raccourci de saisie : les lignes restent modifiables après application."), true);
  assert.equal(editor.includes("disabled={companyVatFranchise}"), true);
  assert.equal(editor.includes("global_vat_enabled: false"), true);
});
