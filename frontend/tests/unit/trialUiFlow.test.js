const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");
const readRepo = (relativePath) => fs.readFileSync(path.join(__dirname, "../../..", relativePath), "utf8");

test("incomplete trials are routed to the active company page", () => {
  const shell = read("src/app/app/AppLayoutClient.tsx");
  const login = read("src/figma/app/pages/auth/LoginPage.tsx");
  const setupRoutes = shell.slice(
    shell.indexOf("const COMPANY_SETUP_ROUTES"),
    shell.indexOf("];", shell.indexOf("const COMPANY_SETUP_ROUTES")),
  );

  assert.doesNotMatch(setupRoutes, /\/app\/dashboard/);
  assert.match(shell, /router\.replace\("\/app\/company\?welcome=1"\)/);
  const incompleteCompanyGate = shell.slice(
    shell.indexOf("if (companyProfileReady === false"),
    shell.indexOf("companyProfileReady === true"),
  );
  assert.doesNotMatch(incompleteCompanyGate, /setRouteNotice/);
  assert.match(read("src/app/app/get-started/page.tsx"), /redirect\("\/app\/company"\)/);
  assert.match(read("src/app/app/onboarding/page.tsx"), /redirect\("\/app\/company"\)/);
  assert.match(read("src/lib/verifiedBillingIntent.ts"), /return "\/app\/company\?welcome=1"/);
  assert.match(login, /return "\/app\/dashboard"/);
  assert.doesNotMatch(login, /return "\/app\/company"/);
  const register = read("src/figma/app/pages/auth/RegisterPage.tsx");
  assert.match(register, /plan: "pro"/);
  assert.doesNotMatch(register, /checkout_requested|billing_period|planOptions/);
});

test("the trial message lives on Mon entreprise and no longer on the dashboard", () => {
  const company = read("src/figma/app/pages/app/CompanyPage.tsx");
  const dashboard = read("src/figma/app/pages/app/DashboardPage.tsx");

  assert.match(company, /Essai Pro de \{TRIAL_DAYS\} jours/);
  assert.match(company, /aucune émission définitive, aucun email client et aucune\s+transmission réelle/);
  assert.match(company, /pixfacture:company:trial-notice:dismissed:v1/);
  assert.match(company, /window\.localStorage\.setItem\(trialNoticeStorageKey, "1"\)/);
  assert.doesNotMatch(dashboard, /StarterTrialCard/);
  assert.doesNotMatch(dashboard, /Essai Starter/);
});

test("trial live actions fail closed in every active sales surface", () => {
  const session = read("src/lib/useSession.ts");
  const editor = read("src/figma/app/components/app/InvoiceDocumentEditor.tsx");
  const invoiceList = readRepo("frontend/figma-compare-srcs/pages/app/InvoicesPage.tsx");
  const quoteList = readRepo("frontend/figma-compare-srcs/pages/app/QuotesPage.tsx");
  const invoiceDetail = read("src/figma/app/pages/app/InvoicesPage.tsx");
  const quoteDetail = read("src/figma/app/pages/app/QuotesPage.tsx");

  assert.match(session, /restrictCapabilitiesForTrial/);
  assert.match(editor, /intent === "issue" && trialDraftOnly/);
  assert.match(editor, /Choisir un abonnement/);
  for (const source of [invoiceList, quoteList, invoiceDetail, quoteDetail]) {
    assert.match(source, /isTrialSubscription\(subscriptionStatus\)/);
    assert.match(source, /TRIAL_LIVE_ACTION_MESSAGE/);
  }
  assert.match(invoiceDetail, /open=\{!trialDraftOnly && emailOpen\}/);
  assert.match(quoteDetail, /open=\{!trialDraftOnly && emailOpen\}/);
});

test("no active frontend copy still promises a Starter trial", () => {
  const activeFiles = [
    "src/figma/app/pages/auth/RegisterPage.tsx",
    "src/figma/app/pages/FaqPage.tsx",
    "src/figma/app/components/landing/FAQ.tsx",
    "src/figma/app/pages/app/BillingPage.tsx",
    "src/figma/app/pages/app/MiscPages.tsx",
    "src/data/pricingCopy.ts",
  ];
  for (const relativePath of activeFiles) {
    assert.doesNotMatch(read(relativePath), /essai Starter/i, relativePath);
  }
});

test("the historical Starter trial clause is isolated and cannot authorize a Pro signup", () => {
  const terms = read("src/figma/app/pages/TermsPage.tsx");
  const register = read("src/figma/app/pages/auth/RegisterPage.tsx");
  const legalDocuments = readRepo("backend/app/legal_documents.py");
  const legalAcceptance = readRepo("backend/app/services/legal_acceptance.py");

  assert.match(terms, /PRO_TRIAL_TERMS_VERSION = "2026-07-14"/);
  assert.match(terms, /HISTORICAL_STARTER_TRIAL_TERMS_VERSION = "2026-07-11"/);
  assert.match(terms, /historicalStarterTrialTermsActive \?/);
  assert.match(terms, /Cette version documentaire n’est pas disponible pour une nouvelle inscription/);
  assert.match(register, /payload\?\.signupReady === true/);
  assert.match(legalDocuments, /PUBLIC_PRO_TRIAL_TERMS_VERSION = "2026-07-14"/);
  assert.match(legalAcceptance, /terms_version != PUBLIC_PRO_TRIAL_TERMS_VERSION/);
  assert.match(legalAcceptance, /return False, message/);
});

test("the active sidebar shows the workspace badge and omits duplicate branding navigation", () => {
  const sidebar = readRepo("frontend/figma-compare-srcs/components/app/AppSidebar.tsx");
  const navigation = read("src/lib/appNavigation.ts");
  const settings = readRepo("frontend/figma-compare-srcs/pages/app/SettingsPages.tsx");

  assert.match(sidebar, /getWorkspacePlanBadge\(plan, subscriptionStatus\)/);
  assert.match(sidebar, /Formule : \$\{planBadge\.label\}/);
  assert.doesNotMatch(navigation, /id: "branding"/);
  assert.doesNotMatch(settings, /href: "\/app\/settings\/branding"/);
  assert.match(read("src/app/app/settings/branding/page.tsx"), /redirect\("\/app\/company"\)/);
});
