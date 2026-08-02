const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");

const section = (source, start, end) => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `section introuvable: ${start}`);
  assert.notEqual(endIndex, -1, `fin de section introuvable: ${end}`);
  return source.slice(startIndex, endIndex);
};

test("le mode export Pro ne charge pas les parcours connectés", () => {
  const source = read("src/figma/app/pages/app/EinvoicingPages.tsx");
  const setup = section(source, "export function SetupEinvoicingPage()", "export function IntegrationsPage()");
  const integrations = section(source, "export function IntegrationsPage()", "export function TransmissionsPage()");
  const b2b = section(source, "export function B2BEinvoicingPage()", "export function SetupEinvoicingPage()");

  assert.match(source, /Mode export actif/);
  assert.match(source, /seqinoOnly \? "Les transmissions Seqino" : "Les transmissions Seqino\/Chorus"/);
  assert.match(source, /documents Factur-X\/CII, et UBL si ce format est disponible/);

  for (const guardedPage of [setup, integrations]) {
    assert.match(guardedPage, /!einvoicingEnabled \|\| !einvoicingOperational/);
    assert.match(guardedPage, /einvoicingEnabled && !einvoicingOperational \? <ExportOnlyModeNotice/);
  }

  assert.match(b2b, /const seqinoOperational = einvoicingEnabled && Boolean\(capabilities\?\.seqino_operational\)/);
  assert.match(b2b, /!einvoicingEnabled \|\| !seqinoOperational/);
  assert.match(b2b, /<ExportOnlyModeNotice seqinoOnly \/>/);
  assert.match(setup, /!seqinoOperational \|\| !canManageIntegration \|\| activationBusy/);
  assert.match(setup, /!sessionLoading && seqinoOperational/);
  assert.match(setup, /enabled=\{Boolean\(seqinoOperational && capabilities\?\.token_topup_enabled\)\}/);
  assert.match(integrations, /if \(!einvoicingOperational \|\| !slug\) return/);
  assert.match(integrations, /!einvoicingEnabled \|\| !einvoicingOperational \? null/);
});

test("l'e-reporting masque l'envoi sans connecteur mais conserve génération et exports", () => {
  const source = read("src/figma/app/pages/app/EinvoicingPages.tsx");
  const reporting = section(source, "export function EReportingPage()", "export function ConformiteAppPage()");

  assert.match(
    reporting,
    /const eReportingSendOperational = einvoicingEnabled && Boolean\(capabilities\?\.seqino_operational\)/,
  );
  assert.match(reporting, /if \(!eReportingSendOperational\) return/);
  assert.match(reporting, /\{eReportingSendOperational \? \(/);
  assert.match(reporting, /Exporter la période/);
  assert.match(reporting, /Exporter le rapport/);
  assert.match(reporting, /<ExportOnlyModeNotice seqinoOnly \/>/);
});

test("l'historique des transmissions reste disponible en mode export", () => {
  const source = read("src/figma/app/pages/app/EinvoicingPages.tsx");
  const transmissions = section(source, "export function TransmissionsPage()", "export function DirectoryPage()");

  assert.match(transmissions, /readJson\("\/api\/platforms\/transmissions"\)/);
  assert.match(transmissions, /<ExportOnlyModeNotice \/>/);
  assert.match(transmissions, /transmissions déjà enregistrées restent consultables ici/);
  assert.doesNotMatch(transmissions, /plus rassurant pour la vente|vendable/);
});

test("l'annuaire ne charge et n'expose Seqino que lorsque le connecteur est opérationnel", () => {
  const source = read("src/figma/app/pages/app/EinvoicingPages.tsx");
  const directory = section(source, "export function DirectoryPage()", "function readInboxFiltersFromLocation()");

  assert.match(
    directory,
    /const seqinoOperational = einvoicingEnabled && Boolean\(capabilities\?\.seqino_operational\)/,
  );
  assert.match(directory, /if \(!einvoicingEnabled \|\| !seqinoOperational\)/);
  assert.match(directory, /\}, \[einvoicingEnabled, seqinoOperational\]\)/);
  assert.match(directory, /if \(!seqinoOperational\) return/);
  assert.match(directory, /!seqinoOperational \? \(/);
  assert.match(directory, /title="Mode export actif"/);
  assert.match(directory, /historique des transmissions/);
  assert.match(directory, /sessionLoading \? null : seqinoOperational \? \(/);
});

test("les paramètres plateformes n'appellent et n'affichent que les réseaux opérationnels", () => {
  const source = read("src/figma/app/pages/app/SettingsPages.tsx");
  const platforms = section(
    source,
    "export function SettingsPlatformsPage()",
    "export function SettingsAttachmentsPage()",
  );

  assert.match(
    platforms,
    /const seqinoOperational = einvoicingEnabled && Boolean\(capabilities\?\.seqino_operational\)/,
  );
  assert.match(
    platforms,
    /const chorusOperational = einvoicingEnabled && Boolean\(capabilities\?\.chorus_operational\)/,
  );
  assert.match(platforms, /const platformOperational = seqinoOperational \|\| chorusOperational/);
  assert.match(platforms, /if \(!einvoicingEnabled \|\| !platformOperational\)/);
  assert.match(
    platforms,
    /seqinoOperational \? rawApi\("\/api\/platforms\/onboarding-status"\) : Promise\.resolve\(null\)/,
  );
  assert.match(
    platforms,
    /seqinoOperational \? rawApi\("\/api\/platforms\/seqino\/mandates"\) : Promise\.resolve\(null\)/,
  );
  assert.match(platforms, /isOperationalPlatformConnector\(item\?\.provider_slug/);
  assert.match(platforms, /isOperationalPlatformConnector\(item\?\.slug/);
  assert.match(
    platforms,
    /if \(!isOperationalPlatformConnector\(slug, seqinoOperational, chorusOperational\)\) return/,
  );
  assert.match(platforms, /enabled=\{Boolean\(seqinoOperational && capabilities\?\.token_topup_enabled\)\}/);
  assert.match(platforms, /!platformOperational \? \(/);
  assert.match(platforms, /title="Mode export actif"/);
  assert.match(platforms, /\{chorusOperational \? \(/);
  assert.match(platforms, /\{seqinoOperational \? \(/);
});

test("le dashboard Starter n'interroge ni n'affiche achats et paiements", () => {
  const dashboard = read("src/figma/app/pages/app/DashboardPage.tsx");

  assert.match(dashboard, /paymentsEnabled \? rawApi\("\/api\/collections\/dashboard"\) : Promise\.resolve\(null\)/);
  assert.match(
    dashboard,
    /paymentsEnabled \? rawApi\("\/api\/collections\/cash-dashboard"\) : Promise\.resolve\(null\)/,
  );
  assert.match(dashboard, /purchasesEnabled\s+\? rawApi\("\/api\/inbox\/summary/);
  assert.match(dashboard, /purchasesEnabled\s+\? rawApi\("\/api\/ops\/purchase-workflow-summary"\)/);
  assert.match(dashboard, /purchasesEnabled\s+\? rawApi\("\/api\/cockpit\/vat/);
  assert.match(dashboard, /availableSeries=\{availableAnalysisSeries\}/);
  assert.match(dashboard, /paymentsEnabled \? \(\s*<RecentPaymentsPanel/);
  assert.match(dashboard, /purchasesEnabled \|\| cell\.label !== "Achats"/);
});
