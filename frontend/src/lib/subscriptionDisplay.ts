import { TRIAL_DAYS } from "./billingConstants";

type PlanInfo = {
  id: string;
  name: string;
  label: string;
  priceLabel: string | null;
};

type StatusInfo = {
  id: string;
  label: string;
  className: string;
};

export type WorkspacePlanBadge = {
  id: "trial" | "starter" | "pro" | "volume";
  label: "Essai" | "Starter" | "Pro" | "Volume";
};

const normalizeToken = (value?: string | null) => {
  if (!value) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
};

const PLAN_DEFS = {
  starter: {
    name: "Starter",
    priceLabel: null,
  },
  pro: {
    name: "Pro",
    priceLabel: null,
  },
  enterprise: {
    name: "Volume",
    priceLabel: "Sur devis",
  },
  free: {
    name: "Gratuit",
    priceLabel: null,
  },
  trial: {
    name: "Essai",
    priceLabel: `${TRIAL_DAYS} jours`,
  },
} as const;

const PLAN_ALIASES: Record<string, keyof typeof PLAN_DEFS> = {
  essential: "starter",
  essentials: "starter",
  starter: "starter",
  standard: "pro",
  pro: "pro",
  starter_monthly: "starter",
  starter_yearly: "starter",
  pro_monthly: "pro",
  pro_yearly: "pro",
};

const STATUS_DEFS: Record<string, { label: string; className: string }> = {
  active: { label: "Actif", className: "status-active" },
  trialing: { label: "Essai en cours", className: "status-trial" },
  past_due: { label: "Paiement en retard", className: "status-danger" },
  canceled: { label: "Résilié", className: "status-danger" },
  unpaid: { label: "Impayé", className: "status-danger" },
  incomplete: { label: "À compléter", className: "status-warning" },
  incomplete_expired: { label: "Expiré", className: "status-danger" },
  paused: { label: "Suspendu", className: "status-warning" },
  trial_expired: { label: "Essai expiré", className: "status-warning" },
  grace_period: { label: "Période de grâce", className: "status-warning" },
  inactive: { label: "Inactif", className: "status-warning" },
  inactif: { label: "Inactif", className: "status-warning" },
};

const STATUS_ALIASES: Record<string, string> = {
  trial: "trialing",
  pastdue: "past_due",
  past_due: "past_due",
  cancel: "canceled",
  cancelled: "canceled",
};

export function getPlanInfo(plan?: string | null): PlanInfo | null {
  const normalized = normalizeToken(plan);
  if (!normalized) return null;
  const key = PLAN_ALIASES[normalized] || (normalized as keyof typeof PLAN_DEFS);
  const entry = PLAN_DEFS[key];
  if (!entry) return null;
  const label = entry.priceLabel ? `Plan ${entry.name} - ${entry.priceLabel}` : `Plan ${entry.name}`;
  return {
    id: key,
    name: entry.name,
    label,
    priceLabel: entry.priceLabel ?? null,
  };
}

export function getSubscriptionStatusInfo(status?: string | null): StatusInfo | null {
  const normalized = normalizeToken(status);
  if (!normalized) return null;
  const key = STATUS_ALIASES[normalized] || normalized;
  const entry = STATUS_DEFS[key];
  if (!entry) {
    return { id: key, label: "Statut inconnu", className: "status-muted" };
  }
  return { id: key, label: entry.label, className: entry.className };
}

export function getWorkspacePlanBadge(
  plan?: string | null,
  subscriptionStatus?: string | null,
): WorkspacePlanBadge | null {
  const normalizedStatus = normalizeToken(subscriptionStatus);
  if (normalizedStatus === "trial" || normalizedStatus === "trialing") {
    return { id: "trial", label: "Essai" };
  }

  const normalizedPlan = getPlanInfo(plan)?.id;
  if (normalizedPlan === "starter") return { id: "starter", label: "Starter" };
  if (normalizedPlan === "pro") return { id: "pro", label: "Pro" };
  if (normalizedPlan === "enterprise") return { id: "volume", label: "Volume" };
  return null;
}
