import { api, sanitizeUserFacingApiMessage } from "@/lib/api";

type WaitForJobOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  onUpdate?: (payload: any) => void;
};

const TERMINAL_SUCCESS = new Set(["finished", "success", "succeeded", "done", "completed"]);
const TERMINAL_FAILURE = new Set(["failed", "stopped", "canceled", "cancelled"]);
const PROGRESS_LABELS: Record<string, string> = {
  validation: "Validation des données",
  generation: "Génération du PDF et de la facture électronique",
  finalize: "Finalisation et preuve d'émission",
};
const STATUS_LABELS: Record<string, string> = {
  queued: "Traitement en file d'attente",
  scheduled: "Traitement planifié",
  deferred: "Traitement en attente",
  started: "Traitement en cours",
  finished: "Traitement terminé",
  success: "Traitement terminé",
  succeeded: "Traitement terminé",
  done: "Traitement terminé",
  completed: "Traitement terminé",
  failed: "Traitement échoué",
  stopped: "Traitement arrêté",
  canceled: "Traitement annulé",
  cancelled: "Traitement annulé",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function jobErrorMessage(payload: any) {
  const error = payload?.error || payload?.result?.error;
  return sanitizeUserFacingApiMessage(
    error?.message || error?.detail || payload?.message,
    undefined,
    "Le traitement a échoué. Réessayez dans quelques instants.",
  );
}

function buildJobError(payload: any) {
  const error = payload?.error || payload?.result?.error || {};
  const err = new Error(jobErrorMessage(payload)) as Error & {
    code?: string;
    errors?: string[];
    fields?: string[];
  };
  if (typeof error?.code === "string") err.code = error.code;
  if (Array.isArray(error?.errors)) err.errors = error.errors.map((item: unknown) => String(item)).filter(Boolean);
  if (Array.isArray(error?.fields)) err.fields = error.fields.map((item: unknown) => String(item)).filter(Boolean);
  return err;
}

export function describeJobProgress(payload: any) {
  const progress = String(payload?.progress || "").toLowerCase();
  if (progress && PROGRESS_LABELS[progress]) return PROGRESS_LABELS[progress];
  const status = String(payload?.status || "").toLowerCase();
  return STATUS_LABELS[status] || "Traitement en cours";
}

export async function waitForJob(jobId: string, options: WaitForJobOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 90000;
  const intervalMs = options.intervalMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  let lastPayload: any = null;

  while (Date.now() <= deadline) {
    lastPayload = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    options.onUpdate?.(lastPayload);
    const status = String(lastPayload?.status || "").toLowerCase();
    if (TERMINAL_SUCCESS.has(status)) {
      return lastPayload;
    }
    if (TERMINAL_FAILURE.has(status) || lastPayload?.error) {
      throw buildJobError(lastPayload);
    }
    await sleep(intervalMs);
  }

  throw new Error("Le traitement est encore en file d'attente. Rechargez le document dans quelques instants.");
}

export async function waitForMaybeJob(payload: any, options?: WaitForJobOptions) {
  const jobId = typeof payload?.job_id === "string" ? payload.job_id : "";
  if (!jobId) return payload;
  return waitForJob(jobId, options);
}
