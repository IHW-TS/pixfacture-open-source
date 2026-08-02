import { sanitizeUserFacingApiMessage } from "./api";

export type EmailDeliveryStatusTone = "ok" | "warn" | "danger" | "muted" | "info";

type EmailProofSource = Record<string, any> | null | undefined;

export type EmailDeliveryProof = {
  status: EmailDeliveryStatusTone;
  shortLabel: string;
  label: string;
  title: string;
  date: any;
  isFailure: boolean;
  isLogOnly: boolean;
  providerLabel: string;
};

const FAILURE_STATUSES = new Set([
  "blocked",
  "complaint",
  "dropped",
  "error",
  "failed",
  "hard_bounce",
  "invalid",
  "invalid_email",
  "soft_bounce",
  "spam",
  "unsubscribed",
]);

function normalized(value: any) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function providerName(value: any) {
  const provider = normalized(value);
  if (provider === "brevo" || provider === "sendinblue") return "Brevo";
  if (provider === "smtp") return "service d’envoi";
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "fournisseur";
}

function providerStatusLabel(value: string) {
  if (value === "click" || value === "clicked") return "Lien cliqué";
  if (value === "opened" || value === "unique_opened" || value === "proxy_open") return "Ouvert";
  if (value === "delivered") return "Livré";
  if (value === "request" || value === "sent") return "Envoyé";
  if (value === "deferred") return "Différé";
  if (value === "soft_bounce") return "Rebond temporaire";
  if (value === "hard_bounce") return "Rebond définitif";
  if (value === "blocked") return "Bloqué";
  if (value === "complaint" || value === "spam") return "Plainte";
  if (value === "unsubscribed") return "Désinscrit";
  if (value === "invalid" || value === "invalid_email") return "Email invalide";
  if (value === "dropped" || value === "error" || value === "failed") return "Échec";
  return value ? `Statut ${value}` : "";
}

export function emailDeliveryProof(source: EmailProofSource): EmailDeliveryProof {
  const status = normalized(source?.status ?? source?.last_email_status);
  const mode = normalized(source?.delivery_mode ?? source?.last_email_delivery_mode);
  const providerStatus = normalized(source?.provider_status ?? source?.last_email_provider_status);
  const provider = normalized(source?.provider ?? source?.last_email_provider);
  const providerLabel = providerName(provider);
  const date =
    source?.provider_event_at ??
    source?.last_email_provider_event_at ??
    source?.sent_at ??
    source?.last_email_at ??
    source?.created_at ??
    null;
  const error = String(source?.error ?? source?.last_email_error ?? "").trim();
  const userFacingError = sanitizeUserFacingApiMessage(error, 400, "Le dernier email n'a pas pu être envoyé.");

  if (!status && !providerStatus) {
    return {
      status: "muted",
      shortLabel: "Aucun email",
      label: "Aucun email tracé",
      title: "Aucun envoi ou journalisation email n'est encore associé à ce document.",
      date,
      isFailure: false,
      isLogOnly: false,
      providerLabel,
    };
  }

  if (mode === "log_only" || status === "log_only") {
    return {
      status: "warn",
      shortLabel: "Journalisé",
      label: "Journalisé",
      title: "Canal email non configuré : aucun email n'a été envoyé.",
      date,
      isFailure: false,
      isLogOnly: true,
      providerLabel,
    };
  }

  if (providerStatus) {
    const shortLabel = providerStatusLabel(providerStatus);
    const isFailure = FAILURE_STATUSES.has(providerStatus);
    const isPending = providerStatus === "deferred";
    return {
      status: isFailure ? "danger" : isPending ? "info" : "ok",
      shortLabel: provider ? `${shortLabel} ${providerLabel}` : shortLabel,
      label: provider ? `${shortLabel} ${providerLabel}` : shortLabel,
      title: isFailure
        ? userFacingError || `Dernier retour ${providerLabel} : ${shortLabel.toLowerCase()}.`
        : `Dernier retour ${providerLabel} : ${shortLabel.toLowerCase()}.`,
      date,
      isFailure,
      isLogOnly: false,
      providerLabel,
    };
  }

  if (status === "queued") {
    return {
      status: "info",
      shortLabel: "En file",
      label: "Email en file",
      title: "Email créé et en attente de traitement par la file d'envoi.",
      date,
      isFailure: false,
      isLogOnly: false,
      providerLabel,
    };
  }

  if (FAILURE_STATUSES.has(status)) {
    return {
      status: "danger",
      shortLabel: "Email en échec",
      label: "Email en échec",
      title: userFacingError,
      date,
      isFailure: true,
      isLogOnly: false,
      providerLabel,
    };
  }

  if (["sent", "delivered", "opened", "clicked"].includes(status)) {
    return {
      status: "ok",
      shortLabel: providerStatusLabel(status) || "Envoyé",
      label: providerStatusLabel(status) || "Email envoyé",
      title:
        status === "sent"
          ? "Dernier email envoyé par le service d’envoi."
          : `Dernier statut email : ${providerStatusLabel(status).toLowerCase()}.`,
      date,
      isFailure: false,
      isLogOnly: false,
      providerLabel,
    };
  }

  return {
    status: "muted",
    shortLabel: "Statut à vérifier",
    label: "Statut email à vérifier",
    title: "Le statut détaillé de cet email n'est pas encore reconnu.",
    date,
    isFailure: false,
    isLogOnly: false,
    providerLabel,
  };
}
