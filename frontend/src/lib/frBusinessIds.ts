export const normalizeDigits = (value?: string | null) => {
  if (!value) return "";
  return String(value).replace(/\D+/g, "");
};

export const normalizeVatFR = (value?: string | null) => {
  if (!value) return "";
  return String(value).replace(/\s+/g, "").toUpperCase();
};

export const validateSiret = (digits?: string | null) => {
  const value = normalizeDigits(digits || "");
  return /^\d{14}$/.test(value);
};

export const validateSiren = (digits?: string | null) => {
  const value = normalizeDigits(digits || "");
  return /^\d{9}$/.test(value);
};

export const deriveSirenFromSiret = (siret?: string | null) => {
  const digits = normalizeDigits(siret || "");
  return digits.length >= 9 ? digits.slice(0, 9) : "";
};

export const validateVatFR = (vat?: string | null) => {
  const value = normalizeVatFR(vat);
  return /^FR[0-9A-Z]{2}[0-9]{9}$/.test(value);
};
