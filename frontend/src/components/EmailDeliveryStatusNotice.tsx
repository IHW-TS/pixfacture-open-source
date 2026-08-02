"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { api } from "@/lib/api";

type EmailDeliveryStatus = {
  smtp_configured?: boolean;
  delivery_mode?: "smtp" | "log_only" | string;
  delivery_mode_label?: string;
  can_send_real_email?: boolean;
  from_email?: string | null;
  reply_to?: string | null;
  message?: string | null;
};

type Props = {
  open: boolean;
  fallbackReplyTo?: string | null;
};

export default function EmailDeliveryStatusNotice({ open, fallbackReplyTo }: Props) {
  const [status, setStatus] = useState<EmailDeliveryStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setStatus(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api("/api/company/email-delivery-status")
      .then((payload) => {
        if (!cancelled) setStatus((payload || {}) as EmailDeliveryStatus);
      })
      .catch((err) => {
        if (!cancelled) {
          setError("État de l'envoi email indisponible.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (loading && !status) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] font-semibold text-slate-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
        Vérification de l'envoi email...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-800">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {error}
      </div>
    );
  }

  if (!status) return null;

  const smtpReady = status.delivery_mode === "smtp" && status.smtp_configured !== false;
  const replyTo = (status.reply_to || fallbackReplyTo || "").trim();
  const tone = smtpReady
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : "border-amber-200 bg-amber-50 text-amber-800";
  const Icon = smtpReady ? CheckCircle2 : AlertTriangle;
  const label = smtpReady ? "Envoi prêt" : "Envoi à configurer";
  const message = smtpReady
    ? replyTo
      ? `Adresse de réponse : ${replyTo}`
      : "Le message sera envoyé depuis votre adresse d'entreprise."
    : "Aucun email réel ne partira tant que l'envoi n'est pas configuré.";

  return (
    <div
      className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-[12px] font-semibold ${tone}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="rounded-full bg-white/70 px-2 py-0.5 font-extrabold">{label}</span>
      <span className="min-w-0 break-words">{message}</span>
      {!smtpReady ? (
        <span className="ml-auto inline-flex flex-wrap items-center gap-1.5">
          <a
            className="rounded-full bg-white px-2 py-1 font-extrabold text-amber-800 hover:bg-amber-100"
            href="/app/settings/company"
          >
            Configurer
          </a>
        </span>
      ) : null}
    </div>
  );
}
