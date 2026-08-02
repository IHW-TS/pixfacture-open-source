const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const readFrontend = (relativePath) => fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");
const readRepo = (relativePath) => fs.readFileSync(path.join(__dirname, "../../..", relativePath), "utf8");

test("la configuration de production de référence laisse la mesure d'audience désactivée", () => {
  const prodEnv = readRepo(".env.prod.example");
  const marketingLayout = readFrontend("src/app/(marketing)/layout.tsx");
  const analyticsConsent = readFrontend("src/components/AnalyticsConsent.tsx");

  assert.match(prodEnv, /^PLAUSIBLE_DOMAIN=$/m);
  assert.match(prodEnv, /^NEXT_PUBLIC_ANALYTICS_PROVIDER=$/m);
  assert.doesNotMatch(prodEnv, /^PLAUSIBLE_DOMAIN=\S+/m);
  assert.match(marketingLayout, /process\.env\.PLAUSIBLE_DOMAIN/);
  assert.match(analyticsConsent, /const hasAnalytics = Boolean\(plausibleDomain\)/);
  assert.match(analyticsConsent, /if \(!hasAnalytics\) return false/);
});

test("la politique cookies décrit uniquement l'état désactivé réellement disponible", () => {
  const cookies = readFrontend("src/figma/app/pages/CookiesPage.tsx");

  assert.match(cookies, /Désactivée sur cette instance/);
  assert.match(cookies, /Désactivés sur cette instance/);
  assert.match(cookies, /aucun bandeau de consentement\s+ni centre de préférences n'est proposé/);
  assert.match(cookies, /aucun choix de cookies optionnels à\s+modifier/);
  assert.doesNotMatch(cookies, /_analytics/);
  assert.doesNotMatch(cookies, /Vous pouvez modifier vos choix à tout moment/);
  assert.doesNotMatch(cookies, /Cookies d'audience \(si activés\)/);
});

test("la politique de confidentialité reste cohérente avec l'absence d'analytics", () => {
  const privacy = readFrontend("src/figma/app/pages/PrivacyPage.tsx");

  assert.match(privacy, /Cookies optionnels d'audience ou marketing/);
  assert.match(privacy, /Désactivée sur cette instance/);
  assert.match(privacy, /aucun bandeau ni centre de préférences n'est affiché/);
  assert.doesNotMatch(privacy, /Données analytics/);
  assert.doesNotMatch(privacy, /modifier vos choix à tout moment/);
});
