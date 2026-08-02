const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getCompanyProfileReadiness,
  isCompanyProfileReady,
  isSubscriptionAccessReady,
  pathMatchesPrefix,
} = require("../../src/lib/onboardingFlow");

test("company profile readiness requires name, SIRET and address signal", () => {
  assert.equal(
    isCompanyProfileReady({
      name: "Acme",
      siret: "123 456 789 00011",
      address_line1: "10 rue de Paris",
    }),
    true,
  );
  assert.equal(isCompanyProfileReady({ name: "Acme", siret: "123456789", address_line1: "10 rue" }), false);
  assert.equal(isCompanyProfileReady({ name: "Acme", siret: "12345678900011" }), false);
});

test("company readiness stays unknown for legacy test stubs without company fields", () => {
  assert.equal(getCompanyProfileReadiness({ plan: "starter", subscription_status: "active" }), null);
  assert.equal(getCompanyProfileReadiness(null), null);
});

test("subscription access accepts active and trialing only", () => {
  assert.equal(isSubscriptionAccessReady(" active "), true);
  assert.equal(isSubscriptionAccessReady("trialing"), true);
  assert.equal(isSubscriptionAccessReady("past_due"), false);
  assert.equal(isSubscriptionAccessReady(null), false);
});

test("path prefix matching accepts exact path and children", () => {
  assert.equal(pathMatchesPrefix("/app/billing", ["/app/billing"]), true);
  assert.equal(pathMatchesPrefix("/app/billing/paywall", ["/app/billing"]), true);
  assert.equal(pathMatchesPrefix("/app/customers", ["/app/billing"]), false);
});
