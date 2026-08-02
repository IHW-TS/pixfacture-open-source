const normalizeStatus = (value?: string | null) => {
  if (!value) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
};

export const isSubscriptionActive = (status?: string | null) => {
  const normalized = normalizeStatus(status);
  return normalized === "active" || normalized === "trialing";
};

export const isSubscriptionBlocked = (status?: string | null) => {
  const normalized = normalizeStatus(status);
  if (!normalized) return false;
  return !isSubscriptionActive(normalized);
};
