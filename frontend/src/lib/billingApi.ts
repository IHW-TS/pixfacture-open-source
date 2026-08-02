import { apiUrl, fetchWithTimeout } from "./api";
import { SUBSCRIPTION_PLAN_PRICES_CENTS } from "./commercialCatalog";

export type BillingPlanId = "starter" | "pro";
export type BillingPlanPeriod = "monthly" | "yearly";

export type BillingPlan = {
  plan: BillingPlanId;
  period: BillingPlanPeriod;
  currency: string;
  unit_amount: number;
  unit_amount_decimal: string;
  amount_display: string;
  interval: string;
  display_name?: string;
  tagline?: string;
  description?: string;
  features?: {
    billing_enabled?: boolean;
    einvoicing_available_by_plan?: boolean;
    chorus_available_by_plan?: boolean;
    seqino_available_by_plan?: boolean;
    token_topup_available_by_plan?: boolean;
    einvoicing_enabled?: boolean;
    chorus_enabled?: boolean;
    seqino_enabled?: boolean;
    token_topup_enabled?: boolean;
  };
  price_configured?: boolean;
  checkout_enabled?: boolean;
  availability?: "checkout" | "contact" | "unavailable";
  reason?: string | null;
  message?: string | null;
  pricing_source?: "stripe" | "fallback";
};

export type PricingSource = "stripe" | "fallback" | "error";

export type PublicPlansPricing = {
  plans: BillingPlan[];
  source: PricingSource;
  errorCode?: string | null;
};

export type BillingStatus = {
  billing_enabled: boolean;
  subscription_required: boolean;
  stripe_configured: boolean;
  stripe_secret_configured?: boolean;
  subscription_status?: "enabled" | "partial" | "disabled" | "contact" | "unavailable";
  subscription_reason?: string | null;
  subscription_message?: string | null;
  subscription_checkout_enabled?: boolean;
  customer_portal_status?: "enabled" | "disabled" | "unavailable";
  customer_portal_reason?: string | null;
  customer_portal_message?: string | null;
  customer_portal_enabled?: boolean;
  plans_configured?: {
    starter?: { monthly?: boolean; yearly?: boolean };
    pro?: { monthly?: boolean; yearly?: boolean };
  };
  missing_subscription_prices?: string[];
  token_topup_status?: "enabled" | "partial" | "disabled" | "unavailable";
  token_topup_reason?: string | null;
  token_topup_message?: string | null;
  token_topup_configured?: boolean;
  token_packs_configured?: number[];
  missing_token_pack_prices?: string[];
  mode: "live" | "test" | null;
};

const amountDisplayFromCents = (cents: number) => {
  const value = (cents / 100).toFixed(2);
  return value.replace(/\.?0+$/, "") || "0";
};

const buildFallbackPlan = (plan: BillingPlanId, period: BillingPlanPeriod, unitAmount: number): BillingPlan => {
  return {
    plan,
    period,
    currency: "eur",
    unit_amount: unitAmount,
    unit_amount_decimal: String(unitAmount),
    amount_display: amountDisplayFromCents(unitAmount),
    interval: period === "monthly" ? "month" : "year",
    features: {
      billing_enabled: true,
      einvoicing_available_by_plan: plan === "pro",
      chorus_available_by_plan: plan === "pro",
      seqino_available_by_plan: plan === "pro",
      token_topup_available_by_plan: plan === "pro",
      einvoicing_enabled: plan === "pro",
      // Fallback pricing describes commercial eligibility only. It must never
      // pretend that tenant connectors are operational without runtime proof.
      chorus_enabled: false,
      seqino_enabled: false,
      token_topup_enabled: plan === "pro",
    },
    price_configured: false,
    checkout_enabled: false,
    availability: "contact",
    reason: "stripe_not_configured",
    pricing_source: "fallback",
  };
};

const FALLBACK_PLANS: BillingPlan[] = [
  buildFallbackPlan("starter", "monthly", SUBSCRIPTION_PLAN_PRICES_CENTS.starter.monthly),
  buildFallbackPlan("starter", "yearly", SUBSCRIPTION_PLAN_PRICES_CENTS.starter.yearly),
  buildFallbackPlan("pro", "monthly", SUBSCRIPTION_PLAN_PRICES_CENTS.pro.monthly),
  buildFallbackPlan("pro", "yearly", SUBSCRIPTION_PLAN_PRICES_CENTS.pro.yearly),
];

const plansFromPayload = (payload: unknown): BillingPlan[] | null => {
  if (Array.isArray(payload)) return payload as BillingPlan[];
  if (!payload || typeof payload !== "object") return null;
  const plans = (payload as { plans?: unknown }).plans;
  if (Array.isArray(plans)) return plans as BillingPlan[];
  return null;
};

export const formatAmountDisplay = (value: string) => value.replace(".", ",");

export const formatPlanPrice = (plan: BillingPlan, period: BillingPlanPeriod) => {
  const amount = formatAmountDisplay(plan.amount_display);
  const cadence = period === "monthly" ? "mois" : "an";
  return `${amount} € HT / ${cadence}`;
};

export const formatMonthlyEquivalent = (unitAmount: number) => {
  const euros = unitAmount / 100 / 12;
  const formatted = new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(euros);
  return `${formatted} € HT / mois`;
};

export const findPlan = (plans: BillingPlan[], plan: BillingPlanId, period: BillingPlanPeriod) => {
  return plans.find((item) => item.plan === plan && item.period === period) || null;
};

const extractErrorCode = async (res: Response) => {
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;
  const payload = await res.json().catch(() => null);
  if (!payload || typeof payload !== "object") return null;
  const detail = (payload as { detail?: unknown }).detail;
  if (detail && typeof detail === "object") {
    const code = (detail as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  const code = (payload as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
};

const parseBillingStatus = (payload: unknown): BillingStatus | null => {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Partial<BillingStatus>;
  const mode = data.mode === "live" || data.mode === "test" ? data.mode : null;
  return {
    billing_enabled: Boolean(data.billing_enabled),
    subscription_required: Boolean(data.subscription_required),
    stripe_configured: Boolean(data.stripe_configured),
    stripe_secret_configured: Boolean(data.stripe_secret_configured),
    subscription_status:
      data.subscription_status === "enabled" ||
      data.subscription_status === "partial" ||
      data.subscription_status === "disabled" ||
      data.subscription_status === "contact" ||
      data.subscription_status === "unavailable"
        ? data.subscription_status
        : undefined,
    subscription_reason: typeof data.subscription_reason === "string" ? data.subscription_reason : null,
    subscription_message: typeof data.subscription_message === "string" ? data.subscription_message : null,
    subscription_checkout_enabled:
      typeof data.subscription_checkout_enabled === "boolean"
        ? data.subscription_checkout_enabled
        : Boolean(data.stripe_configured),
    customer_portal_status:
      data.customer_portal_status === "enabled" ||
      data.customer_portal_status === "disabled" ||
      data.customer_portal_status === "unavailable"
        ? data.customer_portal_status
        : undefined,
    customer_portal_reason: typeof data.customer_portal_reason === "string" ? data.customer_portal_reason : null,
    customer_portal_message: typeof data.customer_portal_message === "string" ? data.customer_portal_message : null,
    customer_portal_enabled:
      typeof data.customer_portal_enabled === "boolean"
        ? data.customer_portal_enabled
        : Boolean(data.stripe_secret_configured ?? data.stripe_configured),
    plans_configured:
      data.plans_configured && typeof data.plans_configured === "object" ? data.plans_configured : undefined,
    missing_subscription_prices: Array.isArray(data.missing_subscription_prices)
      ? data.missing_subscription_prices.filter((value): value is string => typeof value === "string")
      : undefined,
    token_topup_status:
      data.token_topup_status === "enabled" ||
      data.token_topup_status === "partial" ||
      data.token_topup_status === "disabled" ||
      data.token_topup_status === "unavailable"
        ? data.token_topup_status
        : undefined,
    token_topup_reason: typeof data.token_topup_reason === "string" ? data.token_topup_reason : null,
    token_topup_message: typeof data.token_topup_message === "string" ? data.token_topup_message : null,
    token_topup_configured: typeof data.token_topup_configured === "boolean" ? data.token_topup_configured : undefined,
    token_packs_configured: Array.isArray(data.token_packs_configured)
      ? data.token_packs_configured.filter((value): value is number => typeof value === "number")
      : undefined,
    missing_token_pack_prices: Array.isArray(data.missing_token_pack_prices)
      ? data.missing_token_pack_prices.filter((value): value is string => typeof value === "string")
      : undefined,
    mode,
  };
};

export async function fetchBillingStatus(): Promise<BillingStatus | null> {
  const res = await fetchWithTimeout(apiUrl("/api/billing/status"), {
    method: "GET",
    cache: "no-store",
  });

  if (!res.ok) return null;
  const payload = await res.json().catch(() => null);
  return parseBillingStatus(payload);
}

export async function fetchPublicPlansPricing(): Promise<PublicPlansPricing> {
  const res = await fetchWithTimeout(apiUrl("/api/billing/plans"), {
    method: "GET",
    cache: "no-store",
  });

  if (res.ok) {
    const data = await res.json().catch(() => null);
    const plans = plansFromPayload(data);
    if (!plans) return { plans: [], source: "error", errorCode: "invalid_payload" };
    const hasFallback = plans.some((plan) => plan.pricing_source === "fallback");
    return { plans, source: hasFallback ? "fallback" : "stripe" };
  }

  const errorCode = await extractErrorCode(res);
  if (res.status === 503) {
    return { plans: FALLBACK_PLANS, source: "fallback", errorCode: errorCode || null };
  }

  return {
    plans: [],
    source: "error",
    errorCode: errorCode || `http_${res.status}`,
  };
}
