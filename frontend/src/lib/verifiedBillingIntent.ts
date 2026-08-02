export type VerifiedBillingIntent = {
  plan: "starter" | "pro";
  period: "monthly" | "yearly";
  checkoutRequested: boolean;
  destination: "billing" | "onboarding";
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const POST_VERIFY_DESTINATION_KEY = "preferred_post_verify_destination";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const parseVerifiedBillingIntent = (payload: unknown): VerifiedBillingIntent | null => {
  if (!isRecord(payload) || !isRecord(payload.billing_intent)) return null;
  const raw = payload.billing_intent;
  const plan = raw.plan;
  const period = raw.period;
  const checkoutRequested = raw.checkout_requested === true;
  const expectedDestination = checkoutRequested ? "billing" : "onboarding";
  if (plan !== "starter" && plan !== "pro") return null;
  if (period !== "monthly" && period !== "yearly") return null;
  if (raw.destination !== expectedDestination) return null;
  return { plan, period, checkoutRequested, destination: expectedDestination };
};

export const clearVerifiedBillingIntent = (storage: StorageLike) => {
  storage.removeItem("preferred_plan");
  storage.removeItem("preferred_billing_period");
  storage.removeItem("preferred_checkout");
  storage.removeItem(POST_VERIFY_DESTINATION_KEY);
};

export const persistVerifiedBillingIntent = (storage: StorageLike, intent: VerifiedBillingIntent) => {
  storage.setItem("preferred_plan", intent.plan);
  storage.setItem("preferred_billing_period", intent.period);
  storage.setItem(POST_VERIFY_DESTINATION_KEY, "onboarding");
  storage.removeItem("preferred_checkout");
};

export const postVerifyPathFromStorage = (storage: StorageLike): string | null => {
  const plan = storage.getItem("preferred_plan");
  const period = storage.getItem("preferred_billing_period");
  const destination = storage.getItem(POST_VERIFY_DESTINATION_KEY);
  if (plan !== "starter" && plan !== "pro") return null;
  if (period !== "monthly" && period !== "yearly") return null;
  storage.removeItem("preferred_checkout");
  if (destination === "billing" || destination === "onboarding") {
    return "/app/company?welcome=1";
  }
  return null;
};
