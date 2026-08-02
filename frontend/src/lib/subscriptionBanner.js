const normalizeSubscriptionStatus = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim().toLowerCase();
};

const shouldShowSubscriptionBanner = (value) => {
  const normalized = normalizeSubscriptionStatus(value);
  if (!normalized) return false;
  return !["active", "trialing"].includes(normalized);
};

const getTrialDaysLeft = (trialEnd) => {
  if (!trialEnd) return null;
  const end = new Date(trialEnd);
  if (Number.isNaN(end.getTime())) return null;
  const diffMs = end.getTime() - Date.now();
  const days = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  return Math.max(0, days);
};

const getTrialLabel = (trialEnd) => {
  const days = getTrialDaysLeft(trialEnd);
  if (days === null) return null;
  return `Essai : J-${days}`;
};

module.exports = {
  normalizeSubscriptionStatus,
  shouldShowSubscriptionBanner,
  getTrialDaysLeft,
  getTrialLabel,
};
