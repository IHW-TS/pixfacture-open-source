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

test("la fiche admin active configure Chorus sans persister les identifiants dans le navigateur", () => {
  const route = read("src/app/app/admin/tenants/[id]/page.tsx");
  const bridge = read("src/figma-compare/pages/app/AdminPages.ts");
  const source = read("src/figma/app/pages/app/AdminPages.tsx");
  const tenantDetail = section(
    source,
    "export function AdminTenantDetailPage()",
    "export function AdminReadinessPage()",
  );

  assert.match(route, /@figma-compare\/pages\/app\/AdminPages/);
  assert.match(bridge, /AdminTenantDetailPage = mod\.AdminTenantDetailPage/);
  assert.match(tenantDetail, /method: "PUT"/);
  assert.match(
    tenantDetail,
    /\/api\/platforms\/admin\/tenants\/\$\{encodeURIComponent\(tenantId\)\}\/choruspro\/connection/,
  );
  assert.match(tenantDetail, /technical_login: technicalLogin/);
  assert.match(tenantDetail, /technical_password: chorusTechnicalPassword/);
  assert.match(tenantDetail, /type="password"[\s\S]*aria-label="Mot de passe technique Chorus Pro"/);
  assert.match(tenantDetail, /setChorusTechnicalPassword\(""\)/);
  assert.match(tenantDetail, /Configuré, vérification requise/);
  assert.doesNotMatch(tenantDetail, /localStorage|sessionStorage/);
});

test("la fiche admin hydrate le statut réel et confirme le remplacement des identifiants", () => {
  const source = read("src/figma/app/pages/app/AdminPages.tsx");
  const tenantDetail = section(
    source,
    "export function AdminTenantDetailPage()",
    "export function AdminReadinessPage()",
  );
  const summaryLoader = section(tenantDetail, "const loadChorusSummary", "const configureChorus");

  assert.match(
    summaryLoader,
    /\/api\/platforms\/admin\/tenants\/\$\{encodeURIComponent\(tenantId\)\}\/choruspro\/connection/,
  );
  assert.match(summaryLoader, /typeof result\?\.configured !== "boolean"/);
  assert.match(summaryLoader, /\["verified", "connected"\]\.includes\(connectionStatus\)/);
  assert.match(summaryLoader, /result\?\.verified_at/);
  assert.doesNotMatch(summaryLoader, /technical_login|technical_password/);
  assert.match(tenantDetail, /void loadChorusSummary\(\)/);
  assert.match(tenantDetail, /Remplacer les identifiants existants Chorus Pro/);
  assert.match(tenantDetail, /Pilote connecté/);
  assert.match(tenantDetail, /Non configuré/);
});

test("la fiche admin vérifie le compte Chorus en lecture seule et sans double clic", () => {
  const source = read("src/figma/app/pages/app/AdminPages.tsx");
  const tenantDetail = section(
    source,
    "export function AdminTenantDetailPage()",
    "export function AdminReadinessPage()",
  );

  assert.match(
    tenantDetail,
    /\/api\/platforms\/admin\/tenants\/\$\{encodeURIComponent\(tenantId\)\}\/choruspro\/verify/,
  );
  assert.match(tenantDetail, /method:\s*"POST"/);
  assert.match(tenantDetail, /if \(!tenantId \|\| !chorusConfigured[\s\S]*chorusVerifying[\s\S]*\) return/);
  assert.match(tenantDetail, /result\?\.structure_count/);
  assert.match(tenantDetail, /\["verified", "connected"\]\.includes\(verifiedStatus\)/);
  assert.match(tenantDetail, /setChorusConnectionStatus\(verifiedStatus\)/);
  assert.match(tenantDetail, /Compte vérifié — \$\{structureCount\} structure\(s\) rattachée\(s\)/);
  assert.match(tenantDetail, /Vérifié, pilote non activé/);
  assert.match(tenantDetail, /Vérification en lecture seule : aucune facture transmise et aucun pilote activé/);
});

test("la fiche admin révoque les identifiants Chorus après confirmation", () => {
  const source = read("src/figma/app/pages/app/AdminPages.tsx");
  const tenantDetail = section(
    source,
    "export function AdminTenantDetailPage()",
    "export function AdminReadinessPage()",
  );

  assert.match(tenantDetail, /window\.confirm\(/);
  assert.match(
    tenantDetail,
    /\/api\/platforms\/admin\/tenants\/\$\{encodeURIComponent\(tenantId\)\}\/choruspro\/connection/,
  );
  assert.match(tenantDetail, /\{ method: "DELETE" \}/);
  assert.match(tenantDetail, /if \(!tenantId \|\| !chorusConfigured[\s\S]*chorusRevoking[\s\S]*\) return/);
  assert.match(tenantDetail, /setChorusTechnicalLogin\(""\)/);
  assert.match(tenantDetail, /setChorusTechnicalPassword\(""\)/);
  assert.match(tenantDetail, /Révoquer les identifiants Chorus/);
  assert.match(tenantDetail, /Non configuré/);
  assert.doesNotMatch(tenantDetail, /localStorage|sessionStorage/);
});

test("la fiche admin active explicitement le pilote Chorus pour un SIRET qualifié", () => {
  const source = read("src/figma/app/pages/app/AdminPages.tsx");
  const tenantDetail = section(
    source,
    "export function AdminTenantDetailPage()",
    "export function AdminReadinessPage()",
  );

  assert.match(tenantDetail, /chorusConnectionStatus !== "verified"/);
  assert.match(tenantDetail, /chorusConnectionStatus === "verified"/);
  assert.match(
    tenantDetail,
    /\/api\/platforms\/admin\/tenants\/\$\{encodeURIComponent\(tenantId\)\}\/choruspro\/pilot\/activate/,
  );
  assert.match(tenantDetail, /method: "POST"/);
  assert.match(tenantDetail, /body: JSON\.stringify\(\{ recipient_siret: recipientSiret \}\)/);
  assert.match(tenantDetail, /Après levée des garde-fous serveur/);
  assert.match(tenantDetail, /mode export-only et listes d’autorisation/);
  assert.match(tenantDetail, /aria-label="SIRET destinataire pilote"/);
  assert.match(tenantDetail, /maxLength=\{14\}/);
  assert.match(tenantDetail, /Activer le pilote Chorus/);
  assert.match(tenantDetail, /setChorusConnectionStatus\("connected"\)/);
  assert.equal((tenantDetail.match(/activateChorusPilot\(\)/g) || []).length, 1);
  assert.doesNotMatch(tenantDetail, /localStorage|sessionStorage/);
});

test("le formulaire client public envoie le code service et l'engagement Chorus", () => {
  const bridge = read("src/figma-compare/pages/app/CustomersPage.ts");
  const source = read("src/figma/app/pages/app/CustomersPage.tsx");

  assert.match(bridge, /CustomerDetailPage = realMod\.CustomerDetailPage/);
  assert.match(bridge, /CustomerNewPage = realMod\.CustomerNewPage/);
  assert.match(source, /public_service_code: isPublic \? orNull\(form\.public_service_code\) : null/);
  assert.match(source, /public_commitment_reference: isPublic \? orNull\(form\.public_commitment_reference\) : null/);
  assert.match(source, /label="Code service Chorus Pro"/);
  assert.match(source, /label="N° d’engagement juridique \/ bon de commande"/);
  assert.match(source, /isPublic && einvoicingAvailable/);
  assert.match(source, /label="Code service Chorus Pro"[\s\S]*maxLength=\{100\}/);
  assert.match(source, /label="N° d’engagement juridique \/ bon de commande"[\s\S]*maxLength=\{10\}/);
});

test("le formulaire client qualifie manuellement le SIRET dans l'annuaire Chorus", () => {
  const source = read("src/figma/app/pages/app/CustomersPage.tsx");
  const customerForm = section(source, "function CustomerFormFields(", "export function CustomersListPage()");

  assert.match(customerForm, /api\("\/api\/directory\/chorus\/lookup"/);
  assert.match(customerForm, /method: "POST"/);
  assert.match(customerForm, /service_code: chorusServiceCode/);
  assert.match(customerForm, /: \{ siret: chorusSiret \}/);
  assert.match(customerForm, /body: JSON\.stringify\(lookupPayload\)/);
  assert.match(customerForm, /onClick=\{\(\) => void verifyChorusRecipient\(\)\}/);
  assert.equal((customerForm.match(/verifyChorusRecipient\(\)/g) || []).length, 1);
  assert.match(customerForm, /Vérifier dans l’annuaire Chorus Pro/);
  assert.match(customerForm, /Source officielle/);
  assert.match(customerForm, /billing_address_active === true/);
  assert.match(customerForm, /Destinataire public trouvé dans Chorus Pro/);
  assert.match(customerForm, /service_code_required/);
  assert.match(customerForm, /commitment_required/);
  assert.match(customerForm, /service_or_commitment_required/);
  assert.match(customerForm, /raw_payload\?\.services/);
  assert.match(customerForm, /raw_payload\?\.selected_service/);
  assert.match(customerForm, /Ce service impose un numéro d’engagement juridique/);
  assert.match(customerForm, /Services actifs rattachés/);
  assert.doesNotMatch(customerForm, /localStorage|sessionStorage/);
});

test("le panneau pilote affiche l'historique et verrouille les doubles soumissions", () => {
  const bridge = read("src/figma-compare/pages/app/InvoicesPage.ts");
  const source = read("src/figma/app/pages/app/InvoicesPage.tsx");
  const detail = section(source, "export function InvoiceDetailPage()", "export function InvoiceNewPage()");

  assert.match(bridge, /InvoiceDetailPage = realMod\.InvoiceDetailPage/);
  assert.match(detail, /if \(!id \|\| !canWriteInvoices \|\| transmissionBusy\) return/);
  assert.match(detail, /transmissionStatus\?\.history/);
  assert.match(detail, /Transmissions récentes/);
  assert.match(detail, /Une tentative en cours ou acceptée bloquera tout nouvel envoi/);
  assert.match(detail, /disabled=\{!canSubmitTransmission \|\| transmissionBusy\}/);
  assert.match(detail, /!latestTransmission \|\| latestTransmissionBlocked/);
  assert.match(detail, /latestTransmission\?\.delivery_state/);
  assert.match(detail, /latestTransmission\?\.attempt_count/);
  assert.match(detail, /latestTransmissionDeliveryState === "reconciliation_required"/);
  assert.match(detail, /Résultat du dépôt incertain, ne pas renvoyer/);
  assert.match(detail, /!transmissionReconciliationRequired && !chorusRetryUnsupported/);
  assert.match(detail, /Corriger puis créer une nouvelle émission/);
  assert.doesNotMatch(detail, /Transmission lancée/);
});
