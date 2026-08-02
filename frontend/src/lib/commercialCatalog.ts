import catalog from "./commercialCatalog.json";

// The public-image attestation generator reads the same JSON contract. The
// prices used by the application and those recorded in the immutable image
// therefore cannot drift independently.
export const SUBSCRIPTION_PLAN_PRICES_CENTS = catalog.subscription_plan_prices_cents;

export const TOKEN_PACK_OFFERS = catalog.token_pack_offers;

export type SubscriptionPlanId = keyof typeof SUBSCRIPTION_PLAN_PRICES_CENTS;
export type SubscriptionBillingPeriod = keyof (typeof SUBSCRIPTION_PLAN_PRICES_CENTS)["starter"];
