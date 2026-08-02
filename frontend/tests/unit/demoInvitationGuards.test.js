const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");

test("l'essai public est direct et la démo synthétique reste sur invitation privée", () => {
  const login = read("src/figma/app/pages/auth/LoginPage.tsx");
  const register = read("src/figma/app/pages/auth/RegisterPage.tsx");

  assert.match(login, /to="\/app\/register\?plan=pro"/);
  assert.match(login, />Essayer gratuitement</);
  assert.doesNotMatch(login, /contact\?request=demo|Demander une démo/);
  assert.doesNotMatch(login, /demo=1|Essayer la démo/);

  assert.match(register, /window\.location\.hash/);
  assert.match(register, /fragment\.get\("demo_invitation"\)/);
  assert.match(register, /window\.history\.replaceState/);
  assert.match(register, /\/api\/auth\/demo-invitations\/inspect/);
  assert.match(register, /demo_invitation_token: demoInvitationToken/);
  assert.match(register, /readOnly=\{demoRequested\}/);
  assert.match(register, /plan: "pro"/);
  assert.doesNotMatch(register, /checkout_requested|billing_period|planOptions/);
  assert.match(register, /Commencer mon essai gratuit/);
  assert.doesNotMatch(register, /search\?\.get\("demo"\)|search\?\.get\("preset"\)/);
});

test("les anciens liens de démo redirigent vers l'essai Pro", () => {
  const contact = read("src/app/(marketing)/contact/ContactClientPage.tsx");
  const contactRoute = read("src/app/(marketing)/contact/page.tsx");
  const finalCta = read("src/figma/app/components/landing/FinalCTA.tsx");
  const hero = read("src/figma/app/components/landing/Hero.tsx");
  const navbar = read("src/figma/app/components/landing/Navbar.tsx");
  const features = read("src/figma/app/components/landing/Features.tsx");
  const marketingExtras = read("src/figma/app/pages/MarketingExtraPages.tsx");

  assert.match(finalCta, /href="\/app\/register\?plan=pro"/);
  assert.match(finalCta, /Essayer gratuitement/);
  assert.match(contactRoute, /requestedFlow === "demo"/);
  assert.match(contactRoute, /redirect\("\/app\/register\?plan=pro"\)/);
  assert.match(hero, /href="\/app\/register\?plan=pro"/);
  assert.match(navbar, /to="\/app\/register\?plan=pro"/);
  assert.match(features, /href="\/app\/register\?plan=pro"/);
  assert.doesNotMatch(contact, /Demande de démo|contact_page_demo_request|demo-request-process/);
  assert.doesNotMatch(marketingExtras, /Demande de démo|Planifiez une démo/);
  assert.doesNotMatch(finalCta, /contact\?request=demo|Demander une démo/);
});
