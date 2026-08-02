const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

const normalizeOnboardingToken = (value) => {
  if (value === null || value === undefined) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
};

const digitsOnly = (value) => String(value || "").replace(/\D+/g, "");

const hasText = (value) => String(value || "").trim().length > 0;

const hasCompanyProfileSignal = (profile) => {
  if (!profile || typeof profile !== "object") return false;
  return [
    "name",
    "company_name",
    "siret",
    "address",
    "address_line1",
    "postal_code",
    "city",
    "country_code",
    "vat_number",
  ].some((key) => Object.prototype.hasOwnProperty.call(profile, key));
};

const getCompanyProfileReadiness = (profile) => {
  if (!hasCompanyProfileSignal(profile)) return null;
  const name = hasText(profile.name) || hasText(profile.company_name);
  const siretReady = digitsOnly(profile.siret).length === 14;
  const addressReady = hasText(profile.address_line1) || hasText(profile.address) || hasText(profile.city);
  return Boolean(name && siretReady && addressReady);
};

const isCompanyProfileReady = (profile) => getCompanyProfileReadiness(profile) === true;

const isSubscriptionAccessReady = (status) => ACTIVE_SUBSCRIPTION_STATUSES.has(normalizeOnboardingToken(status));

const pathMatchesPrefix = (pathname, prefixes) => {
  const current = String(pathname || "");
  return prefixes.some((prefix) => current === prefix || current.startsWith(`${prefix}/`));
};

module.exports = {
  ACTIVE_SUBSCRIPTION_STATUSES,
  normalizeOnboardingToken,
  digitsOnly,
  getCompanyProfileReadiness,
  isCompanyProfileReady,
  isSubscriptionAccessReady,
  pathMatchesPrefix,
};
