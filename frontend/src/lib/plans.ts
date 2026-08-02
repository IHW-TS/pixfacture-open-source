export type PlanTier = "starter" | "pro" | "enterprise";

export const normalizePlan = (value?: string | null): PlanTier => {
  const raw = (value || "").toString().trim().toLowerCase();
  if (raw === "pro" || raw === "enterprise") return raw;
  return "starter";
};

export const isProPlan = (value?: string | null): boolean => {
  const plan = normalizePlan(value);
  return plan === "pro" || plan === "enterprise";
};
