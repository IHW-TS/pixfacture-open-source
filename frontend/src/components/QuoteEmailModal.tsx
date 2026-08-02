"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useAnimatedPresence } from "@/lib/useAnimatedPresence";
import { api } from "@/lib/api";
import { CircleHelp, Link2, Mail, Paperclip, Plus, RotateCcw, X } from "lucide-react";
import { EmailBodyEditor, type EmailTemplateVariableItem } from "./EmailBodyEditor";

export type QuoteEmailPayload = {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  reply_to?: string;
  include_pdf: boolean;
  include_link: boolean;
  save_as_default?: boolean;
  save_subject_template?: string;
  save_body_template?: string;
};

export type QuoteEmailDefaultTemplatePayload = {
  subject_template: string;
  body_template: string;
};

type Props = {
  open: boolean;
  previewEndpoint?: string | null;
  title?: string;
  submitLabel?: string;
  defaultTo?: string;
  defaultFrom?: string | null;
  defaultSubject?: string | null;
  defaultBody?: string | null;
  defaultAttachmentName?: string | null;
  defaultIncludePdf?: boolean;
  defaultIncludeLink?: boolean;
  attachmentLabel?: string;
  helperText?: string | null;
  showSaveDefault?: boolean;
  saveDefaultLabel?: string;
  saveDefaultHelp?: string | null;
  saveDefaultStorageKey?: string;
  templateVariables?: Record<string, string>;
  onSaveDefault?: (payload: QuoteEmailDefaultTemplatePayload) => Promise<void>;
  submitting?: boolean;
  onClose: () => void;
  onSend: (payload: QuoteEmailPayload) => Promise<void>;
};

type EmailPreviewResponse = {
  html?: string;
};

const splitEmails = (value: string) =>
  value
    .split(/[,;\s]+/g)
    .map((part) => part.trim())
    .filter(Boolean);

const invalidEmails = (value: string) =>
  splitEmails(value).filter((part) => !part.includes("@") || !part.split("@")[1]?.includes("."));

const checkboxClassName = "mt-0.5 h-4 w-4 shrink-0 accent-blue-600";

const VARIABLE_LABELS: Record<string, string> = {
  "{client}": "Client",
  "{number}": "N° devis",
  "{total_ttc}": "Montant TTC",
  "{valid_until}": "Validité",
  "{issue_date}": "Émission",
  "{company}": "Entreprise",
  "{reply_to}": "Email de contact",
  "{quote_link}": "Lien client",
};

const VARIABLE_ORDER = [
  "{client}",
  "{number}",
  "{total_ttc}",
  "{valid_until}",
  "{issue_date}",
  "{company}",
  "{reply_to}",
  "{quote_link}",
];

const CONTACT_LINE_PREFIX = "Vous pouvez contacter l'émetteur à cette adresse :";
const CONTACT_LINE_RE = /^\s*Vous pouvez contacter l[’']émetteur à cette adresse\s*:\s*.+\s*$/i;

const normalizeComposerBody = (value: string, replyTo: string) => {
  const lines = String(value || "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => !CONTACT_LINE_RE.test(line.trim()));
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last -= 1;
  if (last >= 0) {
    let previous = last - 1;
    while (previous >= 0 && !lines[previous].trim()) previous -= 1;
    const previousValue = previous >= 0 ? lines[previous].trim().toLowerCase().replace(/,$/, "") : "";
    const lastValue = lines[last].trim();
    if (
      previousValue === "merci" &&
      (lastValue.toLowerCase() === "entreprise-exemple" ||
        lastValue.toLowerCase() === "votre entreprise" ||
        /^[A-Z0-9 .&'_-]{2,}$/.test(lastValue))
    ) {
      lines.splice(previous);
    } else if (lastValue.toLowerCase().replace(/,$/, "") === "merci") {
      lines.splice(last);
    }
  }
  const contact = replyTo.trim();
  if (contact) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push("");
    lines.push(`${CONTACT_LINE_PREFIX} ${contact}`);
  }
  return lines.join("\n").trim();
};

const reusableTemplateFromRendered = (value: string, variables?: Record<string, string>) => {
  let next = value;
  const entries = Object.entries(variables || {})
    .map(([token, rendered]) => [token.trim(), String(rendered || "").trim()] as const)
    .filter(([token, rendered]) => token && rendered)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [token, rendered] of entries) {
    next = next.split(rendered).join(token);
  }
  return next;
};

const formatSavedAt = (value: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

function InfoHint({ text, label = "Aide" }: { text: string; label?: string }) {
  return (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-blue-200 bg-white text-blue-700"
      title={text}
      aria-label={label}
      role="img"
    >
      <CircleHelp className="h-3.5 w-3.5" />
    </span>
  );
}

export default function QuoteEmailModal({
  open,
  previewEndpoint,
  title = "Envoyer le devis par email",
  submitLabel = "Envoyer le devis",
  defaultTo,
  defaultFrom,
  defaultSubject,
  defaultBody,
  defaultAttachmentName,
  defaultIncludePdf = false,
  defaultIncludeLink = false,
  attachmentLabel = "Ajouter le PDF du devis en pièce jointe",
  helperText = "Adaptez le message si besoin avant l'envoi. Le lien sécurisé permet au client de consulter et répondre au devis.",
  showSaveDefault = false,
  saveDefaultLabel = "Enregistrer comme modèle par défaut",
  saveDefaultHelp = "Le texte sera réutilisé et adapté automatiquement aux prochains documents.",
  saveDefaultStorageKey,
  templateVariables,
  onSaveDefault,
  submitting = false,
  onClose,
  onSend,
}: Props) {
  const { mounted, state } = useAnimatedPresence(open, { exitMs: 180 });
  const fieldId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [to, setTo] = useState(defaultTo || "");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [includePdf, setIncludePdf] = useState(defaultIncludePdf);
  const [includeLink, setIncludeLink] = useState(defaultIncludeLink);
  const [defaultSaveBusy, setDefaultSaveBusy] = useState(false);
  const [defaultSavedAt, setDefaultSavedAt] = useState<string | null>(null);
  const [defaultSaveFingerprint, setDefaultSaveFingerprint] = useState("");
  const [defaultSaveError, setDefaultSaveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const variableItems: EmailTemplateVariableItem[] = VARIABLE_ORDER.map((token) => ({
    token,
    label: VARIABLE_LABELS[token] || token,
    value: String(templateVariables?.[token] || "").trim(),
  })).filter(({ value }) => value && value !== "le lien sécurisé");

  const canSend = useMemo(() => {
    const invalidCopies = [...invalidEmails(cc), ...invalidEmails(bcc), ...invalidEmails(replyTo)];
    if (invalidCopies.length) return false;
    if (replyTo.trim() && splitEmails(replyTo).length !== 1) return false;
    if (!subject.trim() || !body.trim()) return false;
    const trimmed = (to || "").trim();
    const parts = splitEmails(trimmed);
    if (!parts.length) return false;
    return invalidEmails(trimmed).length === 0;
  }, [bcc, body, cc, replyTo, subject, to]);

  const resetMessage = () => {
    setSubject((defaultSubject || "Votre devis").trim());
    setBody(
      normalizeComposerBody(
        defaultBody ||
          "Bonjour,\n\nVotre devis est disponible. Vous pouvez le consulter, l'accepter ou demander un ajustement depuis le portail sécurisé.",
        replyTo,
      ),
    );
    setError(null);
  };

  useEffect(() => {
    if (open) {
      setTo(defaultTo || "");
      setCc("");
      setBcc("");
      const nextReplyTo = (defaultFrom || "").trim();
      setReplyTo(nextReplyTo);
      setShowCc(false);
      setShowBcc(false);
      setSubject((defaultSubject || "Votre devis").trim());
      setBody(
        normalizeComposerBody(
          defaultBody ||
            "Bonjour,\n\nVotre devis est disponible. Pour l'accepter ou le signer, cliquez sur le bouton « Voir le devis », puis validez-le depuis le portail sécurisé.",
          nextReplyTo,
        ),
      );
      setIncludePdf(defaultIncludePdf);
      setIncludeLink(defaultIncludeLink);
      setDefaultSaveBusy(false);
      setDefaultSaveError(null);
      setError(null);
      setPreviewHtml(null);
      setPreviewError(null);
    }
  }, [
    defaultBody,
    defaultFrom,
    defaultIncludeLink,
    defaultIncludePdf,
    defaultSubject,
    defaultTo,
    open,
    showSaveDefault,
  ]);

  useEffect(() => {
    if (!open || !showSaveDefault || !saveDefaultStorageKey) {
      setDefaultSavedAt(null);
      setDefaultSaveFingerprint("");
      setDefaultSaveError(null);
      return;
    }
    try {
      const stored = window.localStorage.getItem(saveDefaultStorageKey);
      const parsed = stored ? JSON.parse(stored) : null;
      setDefaultSavedAt(typeof parsed?.savedAt === "string" ? parsed.savedAt : null);
      setDefaultSaveFingerprint(typeof parsed?.fingerprint === "string" ? parsed.fingerprint : "");
    } catch {
      setDefaultSavedAt(null);
      setDefaultSaveFingerprint("");
    }
    setDefaultSaveError(null);
  }, [open, saveDefaultStorageKey, showSaveDefault]);

  useEffect(() => {
    if (!open || !previewEndpoint) {
      setPreviewHtml(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const result = (await api(previewEndpoint, {
          method: "POST",
          body: JSON.stringify({
            to: to.trim() || null,
            cc: cc.trim() || null,
            bcc: bcc.trim() || null,
            subject: subject.trim(),
            body: body.trim(),
            reply_to: replyTo.trim() || null,
            include_pdf: includePdf,
            include_link: includeLink,
          }),
        })) as EmailPreviewResponse;
        if (!cancelled) setPreviewHtml(result.html || null);
      } catch {
        if (!cancelled) {
          setPreviewHtml(null);
          setPreviewError("Aperçu email indisponible.");
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bcc, body, cc, includeLink, includePdf, open, previewEndpoint, replyTo, subject, to]);

  useEffect(() => {
    if (!mounted) return;
    if (typeof document === "undefined") return;
    document.body.classList.add("no-scroll");
    return () => {
      document.body.classList.remove("no-scroll");
    };
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    if (typeof document === "undefined") return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) || [],
      ).filter((node) => node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [mounted, onClose, submitting]);

  if (!mounted) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const toValue = to.trim();
    const replyToValue = replyTo.trim();
    if (!toValue) {
      setError("Destinataire requis.");
      return;
    }
    if (replyToValue && splitEmails(replyToValue).length !== 1) {
      setError("Une seule adresse de contact est autorisée.");
      return;
    }
    const invalid = [...invalidEmails(toValue), ...invalidEmails(cc), ...invalidEmails(bcc), ...invalidEmails(replyTo)];
    if (invalid.length) {
      setError("Une adresse email est invalide.");
      return;
    }
    if (!subject.trim()) {
      setError("Sujet requis.");
      return;
    }
    if (!body.trim()) {
      setError("Message requis.");
      return;
    }
    try {
      setError(null);
      await onSend({
        to: toValue,
        cc: cc.trim(),
        bcc: bcc.trim(),
        subject: subject.trim(),
        body: body.trim(),
        reply_to: replyToValue || undefined,
        include_pdf: includePdf,
        include_link: includeLink,
        save_as_default: false,
      });
      onClose();
    } catch {
      setError("Envoi impossible pour le moment. Vérifiez les informations puis réessayez.");
    }
  }

  const defaultTemplatePayload = (): QuoteEmailDefaultTemplatePayload => ({
    subject_template: reusableTemplateFromRendered(subject.trim(), templateVariables),
    body_template: reusableTemplateFromRendered(body.trim(), templateVariables),
  });
  const currentDefaultFingerprint = () => {
    const payload = defaultTemplatePayload();
    return `${payload.subject_template}\n---\n${payload.body_template}`;
  };
  const saveDefaultNow = async () => {
    if (!onSaveDefault || defaultSaveBusy) return;
    const payload = defaultTemplatePayload();
    if (!payload.subject_template || !payload.body_template) {
      setDefaultSaveError("Sujet et message requis pour enregistrer.");
      return;
    }
    setDefaultSaveBusy(true);
    setDefaultSaveError(null);
    try {
      await onSaveDefault(payload);
      const savedAt = new Date().toISOString();
      const fingerprint = `${payload.subject_template}\n---\n${payload.body_template}`;
      setDefaultSavedAt(savedAt);
      setDefaultSaveFingerprint(fingerprint);
      if (saveDefaultStorageKey) {
        window.localStorage.setItem(saveDefaultStorageKey, JSON.stringify({ savedAt, fingerprint }));
      }
    } catch {
      setDefaultSaveError("Enregistrement impossible. Vérifiez vos droits puis réessayez.");
    } finally {
      setDefaultSaveBusy(false);
    }
  };

  const fromPreview = replyTo.trim();
  const attachmentHelp =
    helperText || "Le lien sécurisé permet au client de consulter le devis et de répondre depuis le portail.";
  const previewPanel = (
    <div className="flex h-full min-h-[620px] w-full min-w-0 flex-col rounded-xl bg-slate-100 p-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="text-[12px] font-extrabold uppercase tracking-[0.08em] text-slate-500">Aperçu email</div>
        <div className="text-[12px] font-semibold text-blue-700">Actualisé automatiquement</div>
      </div>
      {previewLoading ? (
        <div className="mt-2 flex h-[384px] flex-1 items-center justify-center rounded-lg bg-white text-[13px] font-semibold text-slate-500 lg:h-auto lg:min-h-[560px]">
          Chargement de l'aperçu...
        </div>
      ) : previewError ? (
        <div className="mt-2 flex h-[384px] flex-1 items-center justify-center rounded-lg bg-white px-4 text-center text-[13px] font-semibold text-red-700 lg:h-auto lg:min-h-[560px]">
          {previewError}
        </div>
      ) : previewHtml ? (
        <iframe
          title="Aperçu email"
          className="mt-2 h-[384px] w-full flex-1 border-0 bg-white lg:h-auto lg:min-h-[560px]"
          srcDoc={previewHtml}
          sandbox=""
        />
      ) : (
        <div className="mt-2 flex h-[384px] flex-1 items-center justify-center rounded-lg bg-white text-[13px] font-semibold text-slate-500 lg:h-auto lg:min-h-[560px]">
          L'aperçu apparaîtra après la saisie du message.
        </div>
      )}
    </div>
  );
  const resetButton = (
    <button
      type="button"
      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-white px-3 text-[12px] font-bold text-slate-700 shadow-sm hover:bg-slate-50"
      onClick={resetMessage}
    >
      <RotateCcw className="h-3.5 w-3.5" />
      Texte par défaut
    </button>
  );
  const displayedSavedAt = formatSavedAt(defaultSavedAt);
  const defaultTemplateDirty = Boolean(
    defaultSaveFingerprint && currentDefaultFingerprint() !== defaultSaveFingerprint,
  );
  const saveDefaultStatus = defaultSaveError
    ? defaultSaveError
    : displayedSavedAt
      ? defaultTemplateDirty
        ? `Modifié depuis le dernier enregistrement (${displayedSavedAt}).`
        : `Enregistré le ${displayedSavedAt}.`
      : "Pas encore enregistré comme texte par défaut.";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Envoyer le devis par email"
      className="modal-overlay ui-overlay z-70"
      data-state={state}
    >
      <div
        ref={dialogRef}
        className="w-[calc(100vw-32px)] max-w-[1680px] overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200"
        data-testid="quote-email-modal"
      >
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-5 py-4">
          <div className="flex items-center gap-3">
            <Mail className="h-4 w-4 text-blue-700" />
            <h3 className="m-0 text-[15px] font-extrabold text-slate-900">{title}</h3>
          </div>
          <button
            ref={closeButtonRef}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-slate-600 hover:bg-slate-300"
            aria-label="Fermer"
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="max-h-[calc(96vh-120px)] overflow-y-auto px-5 py-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-stretch">
              <div className="order-2 min-w-0 lg:order-1 lg:flex lg:min-h-0">{previewPanel}</div>
              <div className="order-1 space-y-3 lg:order-2">
                <div className="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-2">
                  <span
                    id={`${fieldId}-recipient-label`}
                    className="whitespace-nowrap text-[13px] font-semibold text-slate-700"
                  >
                    À :
                  </span>
                  <div className="flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-2">
                    <input
                      id={`${fieldId}-to`}
                      aria-labelledby={`${fieldId}-recipient-label`}
                      className="min-w-0 flex-1 bg-transparent px-1 py-2 text-[13px] font-semibold text-slate-800 outline-none"
                      value={to}
                      onChange={(e) => {
                        setTo(e.target.value);
                        if (error) setError(null);
                      }}
                      placeholder="client@exemple.fr, compta@exemple.fr"
                    />
                    <button
                      type="button"
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-blue-700"
                      onClick={() => setShowCc(true)}
                      aria-label="Ajouter CC"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-[36px_minmax(0,1fr)] gap-2">
                  <span />
                  <button
                    type="button"
                    className="w-fit text-[13px] font-bold text-blue-700 hover:text-blue-900"
                    onClick={() => {
                      setShowCc(true);
                      setShowBcc(true);
                    }}
                  >
                    + CC + CCI
                  </button>
                </div>

                {showCc ? (
                  <div className="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-2">
                    <label
                      className="whitespace-nowrap text-[13px] font-semibold text-slate-700"
                      htmlFor={`${fieldId}-cc`}
                    >
                      CC :
                    </label>
                    <input
                      id={`${fieldId}-cc`}
                      className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-[13px] font-semibold text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      value={cc}
                      placeholder="copie@exemple.com"
                      onChange={(event) => setCc(event.target.value)}
                    />
                  </div>
                ) : null}

                {showBcc ? (
                  <div className="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-2">
                    <label
                      className="whitespace-nowrap text-[13px] font-semibold text-slate-700"
                      htmlFor={`${fieldId}-bcc`}
                    >
                      CCI :
                    </label>
                    <input
                      id={`${fieldId}-bcc`}
                      className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-[13px] font-semibold text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      value={bcc}
                      placeholder="copie-cachee@exemple.com"
                      onChange={(event) => setBcc(event.target.value)}
                    />
                  </div>
                ) : null}

                <div className="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-2">
                  <label
                    className="whitespace-nowrap text-[13px] font-semibold text-slate-700"
                    htmlFor={`${fieldId}-reply-to`}
                  >
                    De :
                  </label>
                  <input
                    id={`${fieldId}-reply-to`}
                    className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-[13px] font-semibold text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    value={fromPreview}
                    placeholder="email de contact visible par le client"
                    onChange={(event) => {
                      setReplyTo(event.target.value);
                      if (error) setError(null);
                    }}
                  />
                </div>

                <label className="sr-only" htmlFor={`${fieldId}-subject`}>
                  Sujet
                </label>
                <input
                  id={`${fieldId}-subject`}
                  className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-[13px] font-semibold text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  value={subject}
                  placeholder="Sujet"
                  onChange={(event) => {
                    setSubject(event.target.value);
                    if (error) setError(null);
                  }}
                />

                <label className="sr-only" htmlFor={`${fieldId}-message`}>
                  Message
                </label>
                <EmailBodyEditor
                  value={body}
                  onChange={(nextBody) => {
                    setBody(nextBody);
                    if (error) setError(null);
                  }}
                  variableItems={variableItems}
                  placeholder="Message"
                />

                {showSaveDefault ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5">
                    <div className="min-w-[180px] flex-1">
                      <div className="inline-flex items-center gap-1 text-[13px] font-semibold text-slate-800">
                        {saveDefaultLabel}
                        {saveDefaultHelp ? <InfoHint text={saveDefaultHelp} label="Information modèle email" /> : null}
                      </div>
                      <div
                        className={`mt-0.5 text-[11px] font-semibold ${
                          defaultSaveError ? "text-red-600" : defaultTemplateDirty ? "text-amber-700" : "text-slate-500"
                        }`}
                      >
                        {saveDefaultStatus}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="inline-flex h-8 shrink-0 items-center justify-center rounded-full bg-blue-600 px-3 text-[12px] font-extrabold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
                      onClick={saveDefaultNow}
                      disabled={defaultSaveBusy || !onSaveDefault}
                    >
                      {defaultSaveBusy ? "Enregistrement..." : "Enregistrer par défaut"}
                    </button>
                    {resetButton}
                  </div>
                ) : (
                  <div className="flex justify-end">{resetButton}</div>
                )}

                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="grid min-h-10 grid-cols-[18px_minmax(0,1fr)] items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[13px] font-semibold text-slate-800">
                    <input
                      type="checkbox"
                      className={checkboxClassName}
                      checked={includeLink}
                      onChange={(e) => setIncludeLink(e.target.checked)}
                    />
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <Link2 className="h-3.5 w-3.5 shrink-0 text-blue-700" />
                      <span className="min-w-0 truncate">Lien client</span>
                    </span>
                  </label>
                  <label className="grid min-h-10 grid-cols-[18px_minmax(0,1fr)] items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[13px] font-semibold text-slate-800">
                    <input
                      type="checkbox"
                      className={checkboxClassName}
                      checked={includePdf}
                      onChange={(e) => setIncludePdf(e.target.checked)}
                    />
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                      <span className="min-w-0 truncate">{attachmentLabel}</span>
                      {attachmentHelp ? <InfoHint text={attachmentHelp} label="Information envoi devis" /> : null}
                    </span>
                  </label>
                  {includePdf ? (
                    <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-slate-500 sm:col-span-2">
                      <Paperclip className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 truncate">{defaultAttachmentName || "devis.pdf"}</span>
                    </div>
                  ) : null}
                </div>

                {error ? (
                  <div
                    className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] font-semibold text-red-700"
                    role="status"
                  >
                    {error}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 px-5 pb-5 pt-1">
            <button
              className="inline-flex h-10 items-center justify-center rounded-full border border-slate-200 bg-white px-5 text-[13px] font-bold text-slate-700 hover:bg-slate-100"
              type="button"
              onClick={onClose}
              disabled={submitting}
            >
              Annuler
            </button>
            <button
              className="inline-flex h-10 items-center justify-center rounded-full bg-emerald-500 px-5 text-[13px] font-extrabold text-white shadow-sm hover:bg-emerald-600 disabled:opacity-60"
              type="submit"
              aria-label={submitting ? "Envoi en cours" : "Envoyer"}
              disabled={!canSend || submitting}
            >
              {submitting ? "Envoi du devis..." : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
