const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");
const readRepo = (relativePath) => fs.readFileSync(path.join(__dirname, "../../..", relativePath), "utf8");

test("les champs entreprise ont des libellés associés et des messages annoncés", () => {
  const company = read("src/figma/app/pages/app/CompanyPage.tsx");
  const fieldIds = [
    "company-name",
    "company-legal-form",
    "company-email-reply-to",
    "company-phone",
    "company-share-capital",
    "company-country-code",
    "company-address-line1",
    "company-address-line2",
    "company-postal-code",
    "company-city",
    "company-siret",
    "company-vat-number",
    "company-vat-regime",
    "company-vat-collection",
    "company-default-sales-vat-rate",
    "company-transaction-periodicity",
    "company-late-payment-interest",
    "company-vat-exemption-notice",
    "company-iban",
    "company-bic",
  ];

  for (const fieldId of fieldIds) {
    assert.match(company, new RegExp(`htmlFor="${fieldId}"`), fieldId);
    assert.match(company, new RegExp(`id="${fieldId}"`), fieldId);
  }
  assert.match(company, /role="alert"/);
  assert.match(company, /role="status"/);
  assert.match(company, /aria-live="polite"/);
  assert.match(company, /htmlFor=\{prefixInputId\}/);
  assert.match(company, /htmlFor=\{yearInputId\}/);
  assert.match(company, /htmlFor=\{nextNumberInputId\}/);
});

test("les navigations actives exposent aria-current", () => {
  const sidebar = readRepo("frontend/figma-compare-srcs/components/app/AppSidebar.tsx");
  const mobileDock = readRepo("frontend/figma-compare-srcs/components/app/MobileBottomDock.tsx");

  assert.ok((sidebar.match(/aria-current=\{active \? "page" : undefined\}/g) || []).length >= 2);
  assert.ok((mobileDock.match(/aria-current=\{active \? "page" : undefined\}/g) || []).length >= 2);
});

test("les modales ciblées enferment et restaurent le focus", () => {
  const modalPaths = [
    "src/components/PdfViewerModal.tsx",
    "src/components/ImageViewerModal.tsx",
    "src/components/InvoiceExportsModal.tsx",
    "src/components/BillingLegalAcceptanceModal.tsx",
  ];

  for (const modalPath of modalPaths) {
    const modal = read(modalPath);
    assert.match(modal, /event\.key === "Escape"/, modalPath);
    assert.match(modal, /event\.key !== "Tab"/, modalPath);
    assert.match(modal, /document\.addEventListener\("keydown", onKeyDown\)/, modalPath);
    assert.match(modal, /previouslyFocused\?\.focus\(\)/, modalPath);
    assert.match(modal, /const focusTimer = window\.setTimeout/, modalPath);
    assert.match(modal, /querySelectorAll<HTMLElement>/, modalPath);
  }
});

test("les réglages d'identité visuelle associent leurs libellés", () => {
  const settings = readRepo("frontend/figma-compare-srcs/pages/app/SettingsPages.tsx");

  for (const fieldId of [
    "branding-accent-color",
    "branding-pdf-template",
    "branding-email-signature",
    "branding-email-footer-note",
  ]) {
    assert.match(settings, new RegExp(`htmlFor="${fieldId}"`), fieldId);
    assert.match(settings, new RegExp(`id="${fieldId}"`), fieldId);
  }
  assert.match(settings, /aria-label="Sélectionner la couleur d'accent des emails"/);
});

test("le viewer peut actualiser l'acceptation DPA sans recharger la page", () => {
  const guard = read("src/components/LegalAcceptanceGuard.tsx");

  assert.match(guard, /const handleRetry = \(\) =>/);
  assert.match(guard, /onClick=\{delegatedDocs\.length \? handleRetry : handleAccept\}/);
  assert.match(guard, /: "Actualiser"/);
  assert.doesNotMatch(guard, /window\.location\.reload|location\.reload/);
});

test("les correctifs WCAG ciblés conservent des relations ARIA valides et des cibles clavier", () => {
  const pricing = read("src/app/(marketing)/pricing/PricingClientPage.tsx");
  const dashboard = read("src/figma/app/pages/app/DashboardPage.tsx");
  const login = read("src/figma/app/pages/auth/LoginPage.tsx");
  const register = read("src/figma/app/pages/auth/RegisterPage.tsx");
  const sidebar = readRepo("frontend/figma-compare-srcs/components/app/AppSidebar.tsx");

  assert.match(pricing, /role="group" aria-label="Informations tarifaires"/);
  assert.match(pricing, /<strong aria-hidden="true" className=\{item\.icon === "ok"/);
  assert.match(pricing, /<h2 id="pricing-comparison" className="sr-only">/);
  assert.match(pricing, /aria-expanded=\{showComparison\}/);
  assert.match(pricing, /aria-controls=\{showComparison \? "pricing-comparison-content" : undefined\}/);
  assert.match(pricing, /id="pricing-comparison-content"/);
  assert.ok((dashboard.match(/role="region"/g) || []).length >= 2);
  assert.ok((dashboard.match(/tabIndex=\{0\}/g) || []).length >= 2);
  assert.match(sidebar, /aria-controls=\{mobileOpen \? mobileMenuId : undefined\}/);

  for (const authPage of [login, register]) {
    assert.match(authPage, /aria-label="Afficher ou masquer le mot de passe"/);
    assert.match(authPage, /flex h-8 w-8/);
  }
  assert.ok((login.match(/<(?:Mail|Lock) aria-hidden="true"/g) || []).length >= 2);
});

test("la page contact conserve une hiérarchie de titres sans saut après le h1", () => {
  const contact = read("src/app/(marketing)/contact/ContactClientPage.tsx");

  for (const title of ["Envoyez-nous un message", "Coordonnées", "Support & réponse"]) {
    assert.match(contact, new RegExp(`<h2[^>]*>${title}</h2>`), title);
    assert.doesNotMatch(contact, new RegExp(`<h3[^>]*>${title}</h3>`), title);
  }
});

test("les libellés secondaires ciblés conservent un contraste AA", () => {
  const styles = read("src/app/globals.css");
  const contact = read("src/app/(marketing)/contact/ContactClientPage.tsx");
  const authLayout = read("src/figma/app/components/app/AuthLayout.tsx");
  const login = read("src/figma/app/pages/auth/LoginPage.tsx");
  const register = read("src/figma/app/pages/auth/RegisterPage.tsx");
  const terms = read("src/figma/app/pages/TermsPage.tsx");
  const dpa = read("src/figma/app/pages/DpaPage.tsx");
  const appPageHeader = read("src/figma/app/components/app/AppPageHeader.tsx");
  const compareAppPageHeader = read("figma-compare-srcs/components/app/AppPageHeader.tsx");
  const settings = read("src/figma/app/pages/app/SettingsPages.tsx");

  assert.match(styles, /\.pricing-arc-mobile-compare dt \{\s*color: #64748b;/);
  assert.match(contact, /text-slate-600">\{remainingChars\} caractères restants/);
  for (const label of ["Éditeur", "Références officielles :", "Support public"]) {
    assert.match(terms, new RegExp(`text-slate-600[^>]*>${label}</p>`), label);
  }
  assert.match(dpa, /text-slate-600 mt-2">\s*Dernière mise à jour/);
  assert.match(register, /text-\[#4b5563\] mb-7/);
  assert.match(register, /pl-6 text-\[#475569\]/);
  assert.match(register, /text-\[0\.7rem\] leading-relaxed text-\[#475569\]/);
  assert.match(register, /mt-6[\s\S]*text-\[#475569\]/);
  assert.match(authLayout, /bg-\[#eff6ff\][^\n]*text-\[#1e3a8a\]/);
  assert.match(login, /<p className="text-\[#334155\]"/);
  assert.match(login, /mt-3[^\n]*bg-\[#eff6ff\][^\n]*text-\[#1e3a8a\]/);
  assert.match(appPageHeader, /warn: \{[\s\S]*?bg: "#fffbeb",[\s\S]*?text: "#92400e"/);
  assert.match(appPageHeader, /danger: \{[\s\S]*?bg: "#fef2f2",[\s\S]*?text: "#b91c1c"/);
  assert.match(compareAppPageHeader, /warn: \{[\s\S]*?bg: "#fffbeb",[\s\S]*?text: "#92400e"/);
  assert.match(compareAppPageHeader, /danger: \{[\s\S]*?bg: "#fef2f2",[\s\S]*?text: "#b91c1c"/);
  assert.match(settings, /bg-\[#ecfdf5\] text-\[#047857\]/);
});

test("les navigations marketing et locales ont des noms distincts", () => {
  const navbar = read("src/figma/app/components/landing/Navbar.tsx");
  const legalShell = read("src/figma/app/components/landing/LegalPageShell.tsx");

  assert.match(navbar, /<nav aria-label="Navigation principale"/);
  assert.match(legalShell, /<nav aria-label="Sommaire de la page"/);
});

test("les correctifs mobiles évitent le zoom iOS et préservent la navigation clavier", () => {
  const styles = read("src/figma/styles/index-next.css");
  const navbar = read("src/figma/app/components/landing/Navbar.tsx");
  const login = read("src/figma/app/pages/auth/LoginPage.tsx");
  const register = read("src/figma/app/pages/auth/RegisterPage.tsx");
  const editor = read("src/figma/app/components/app/InvoiceDocumentEditor.tsx");
  const header = read("src/figma/app/components/app/AppPageHeader.tsx");

  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*font-size: 1rem !important;/);
  assert.match(navbar, /event\.key !== "Escape"/);
  assert.match(navbar, /mobileMenuButtonRef\.current\?\.focus\(\)/);
  assert.match(navbar, /ref=\{mobileMenuButtonRef\}/);
  assert.doesNotMatch(login, /autoFocus/);
  assert.doesNotMatch(register, /id="company"[\s\S]{0,800}autoFocus/);
  assert.ok((editor.match(/<h1/g) || []).length >= 3);
  assert.match(header, /hidden shrink-0 text-\[#64748b\][^\n]*sm:inline/);
});

test("les écrans de connexion et d'inscription exposent le panneau marketing comme landmark", () => {
  const authLayout = read("src/figma/app/components/app/AuthLayout.tsx");

  assert.match(authLayout, /<aside\s+aria-label="Présentation de PixFacture"/);
  assert.match(authLayout, /<main[^>]*className="flex-1 flex items-center justify-center/);
});

test("les routes applicatives produisent un titre de document propre à la page", () => {
  const appLayout = read("src/app/app/AppLayoutClient.tsx");

  assert.match(appLayout, /document\.title = getAppDocumentTitle\(pathname\)/);
  assert.match(appLayout, /Nouveau · \$\{getAppRouteLabel\(parent\)\} \| PixFacture/);
  assert.match(appLayout, /Détail · \$\{getAppRouteLabel\(parent\)\} \| PixFacture/);
  assert.match(appLayout, /find\(\(segment\) => APP_ROUTE_LABELS\[segment\]\)/);
});

test("la page tarifs ne vérifie la session que pour un navigateur déjà authentifié", () => {
  const pricing = read("src/app/(marketing)/pricing/PricingClientPage.tsx");

  assert.match(pricing, /import \{ hasHadSession \} from "@\/lib\/sessionFlags"/);
  assert.match(pricing, /useSession\(\{ autoRefresh: sessionCheckEnabled \}\)/);
  assert.match(pricing, /setSessionCheckEnabled\(hasHadSession\(\)\)/);
  assert.doesNotMatch(pricing, /useSession\(\)/);
});
