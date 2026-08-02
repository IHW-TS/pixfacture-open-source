const TECHNICAL_PORTAL_ERROR =
  /\b(api|backend|endpoint|upstream|payload|tenant|csrf|cors|cookie|stack|traceback|exception|internal server error|failed to fetch|fetch failed|networkerror|network request failed|load failed|not found|request_timeout|sql|database|undefined|null|nan|localhost|provider|request_id|smtp|mock|sandbox|duplicate key|foreign key|constraint)\b/i;

const normalizePortalErrorText = (value: unknown) =>
  typeof value === "string"
    ? value
        .replace(/\s*\(id:\s*[^)]*\)\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim()
    : "";

const isPortalErrorCodeText = (value: string) => {
  const clean = value.trim();
  return /^[a-z][a-z0-9_:-]{2,}$/i.test(clean) && /[_:-]/.test(clean) && !/\s/.test(clean);
};

export const PORTAL_DOCUMENT_UNAVAILABLE =
  "Ce document est momentanément indisponible. Réessayez dans quelques instants ou contactez l’émetteur.";

export const PORTAL_ACTION_UNAVAILABLE =
  "Cette action n'a pas pu être réalisée pour le moment. Réessayez dans quelques instants ou contactez l’émetteur.";

export const PORTAL_PAYMENT_UNAVAILABLE =
  "Le paiement est momentanément indisponible. Réessayez dans quelques instants ou contactez l’émetteur.";

export function portalErrorMessage(value: unknown, fallback = PORTAL_ACTION_UNAVAILABLE) {
  const message = normalizePortalErrorText(value);
  if (!message || isPortalErrorCodeText(message) || TECHNICAL_PORTAL_ERROR.test(message)) return fallback;
  return message.slice(0, 180);
}

export async function portalResponseMessage(response: Response, fallback = PORTAL_ACTION_UNAVAILABLE) {
  const data = await response.json().catch(() => null);
  return portalErrorMessage(
    data?.error?.message ||
      (typeof data?.error === "string" ? data?.message || data?.detail : null) ||
      data?.detail?.message ||
      data?.detail ||
      data?.message,
    fallback,
  );
}
