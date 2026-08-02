import { apiUrl, extractUserFacingApiMessage, fetchWithTimeout } from "./api";
import { defaultAuthCredentials, getAuthHeader } from "./auth";
import { logout } from "./authCookies";

const PROTECTED_DOWNLOAD_TIMEOUT_MS = 60000;

const sanitizeFilename = (name: string | null): string | null => {
  if (!name) return null;
  const cleaned = name
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\\/]/g, "-")
    .trim();
  return cleaned || null;
};

export const parseContentDispositionFilename = (header: string | null): string | null => {
  if (!header) return null;
  const filenameStarMatch = header.match(/filename\*\s*=\s*([^;]+)/i);
  if (filenameStarMatch?.[1]) {
    let value = filenameStarMatch[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const parts = value.split("''");
    const encoded = parts.length > 1 ? parts.slice(1).join("''") : value;
    try {
      const decoded = decodeURIComponent(encoded.replace(/\+/g, "%20"));
      return sanitizeFilename(decoded);
    } catch {
      return sanitizeFilename(encoded);
    }
  }
  const filenameMatch = header.match(/filename\s*=\s*([^;]+)/i);
  if (filenameMatch?.[1]) {
    let value = filenameMatch[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return sanitizeFilename(value);
  }
  return null;
};

const fallbackFilename = (contentType: string | null): string => {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("text/csv") || ct.includes("application/csv")) return "export.csv";
  if (ct.includes("application/pdf")) return "download.pdf";
  if (ct.includes("application/xml") || ct.includes("text/xml")) return "export.xml";
  return "download";
};

export async function downloadProtectedFile(path: string, filename?: string, openInNewTab?: boolean): Promise<void> {
  let openedWindow: Window | null = null;
  const showOpenedWindowError = (message: string) => {
    if (!openedWindow || openedWindow.closed) return;
    openedWindow.document.title = "Document indisponible";
    openedWindow.document.body.textContent = message;
  };
  if (openInNewTab) {
    openedWindow = window.open("about:blank", "_blank");
    if (!openedWindow) {
      const err: any = new Error("Ouverture du document bloquée par le navigateur.");
      err.code = "popup_blocked";
      throw err;
    }
    openedWindow.document.title = "Chargement du document";
    openedWindow.document.body.textContent = "Chargement du document...";
  }
  const headers = { ...getAuthHeader() };
  let res: Response;
  try {
    res = await fetchWithTimeout(apiUrl(path), {
      cache: "no-store",
      credentials: defaultAuthCredentials(),
      headers: Object.keys(headers).length ? headers : undefined,
      timeoutMs: PROTECTED_DOWNLOAD_TIMEOUT_MS,
    });
  } catch (err: any) {
    const message =
      err?.code === "request_timeout"
        ? "Le document met trop de temps à répondre. Réessayez dans quelques instants."
        : "Document indisponible. Réessayez dans quelques instants.";
    showOpenedWindowError(message);
    throw err;
  }
  if (res.status === 401) {
    logout();
    const err: any = new Error("session_expired");
    err.code = "session_expired";
    showOpenedWindowError("Session expirée. Reconnecte-toi puis réessaie.");
    throw err;
  }
  if (res.status === 403) {
    const ct = res.headers.get("content-type") || "";
    const raw = ct.includes("application/json")
      ? await res.json().catch(() => null)
      : await res.text().catch(() => null);
    const message = extractUserFacingApiMessage(
      raw,
      res.status,
      "Vous n'avez pas l'autorisation de télécharger ce document.",
    );
    const err: any = new Error(message);
    err.code = "forbidden";
    err.status = 403;
    showOpenedWindowError(message);
    throw err;
  }
  if (!res.ok) {
    const ct = res.headers.get("content-type") || "";
    const raw = ct.includes("application/json")
      ? await res.json().catch(() => null)
      : await res.text().catch(() => null);
    let message = "Téléchargement impossible. Réessayez dans quelques instants.";
    let code: string | undefined;
    let fields: any;
    let errors: any;
    let qualityChecks: any;
    if (raw) {
      if (typeof raw === "string") {
        message = raw || message;
      } else if ((raw as any).error) {
        const errPayload = (raw as any).error;
        message = errPayload.message || errPayload.detail || message;
        code = errPayload.code || code;
        fields = errPayload.fields || fields;
        errors = errPayload.errors || errors;
        qualityChecks = errPayload.quality_checks || qualityChecks;
      } else if ((raw as any).detail) {
        const detail = (raw as any).detail;
        if (typeof detail === "string") {
          message = detail || message;
        } else {
          message = detail.message || message;
          code = detail.code || code;
          fields = detail.fields || fields;
          errors = detail.errors || errors;
          qualityChecks = detail.quality_checks || qualityChecks;
        }
      } else {
        message = (raw as any).message || message;
        code = (raw as any).code || code;
        fields = (raw as any).fields || fields;
        errors = (raw as any).errors || errors;
        qualityChecks = (raw as any).quality_checks || qualityChecks;
      }
    }
    message = extractUserFacingApiMessage(
      raw || message,
      res.status,
      "Téléchargement impossible. Réessayez dans quelques instants.",
    );
    const err: any = new Error(message);
    err.status = res.status;
    if (code) err.code = code;
    if (fields) err.fields = fields;
    if (errors) err.errors = errors;
    if (qualityChecks) err.quality_checks = qualityChecks;
    showOpenedWindowError(message);
    throw err;
  }
  const contentDisposition = res.headers.get("content-disposition");
  const contentType = res.headers.get("content-type");
  const resolvedFilename =
    filename || parseContentDispositionFilename(contentDisposition) || fallbackFilename(contentType);
  const responseBlob = await res.blob();
  const blob = responseBlob;
  const url = URL.createObjectURL(blob);
  if (openedWindow) {
    openedWindow.document.title = resolvedFilename;
    openedWindow.location.href = url;
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  if (resolvedFilename) a.download = resolvedFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Backward compatibility for existing calls
export const downloadProtected = downloadProtectedFile;
