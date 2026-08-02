"use client";

import type { FormEvent, ReactNode } from "react";
import { useId } from "react";
import { ArrowRight, CheckCircle2, XCircle } from "lucide-react";
import styles from "../i/[token]/page.module.css";

export type QuoteDecision = "none" | "accept" | "reject";
type QuoteResponseStatusTone = "info" | "success" | "error";

export type QuoteResponseSummaryItem = {
  label: string;
  value: string;
};

type QuoteResponsePanelProps = {
  decision: QuoteDecision;
  summary: QuoteResponseSummaryItem[];
  busy: string | null;
  name: string;
  email: string;
  reason: string;
  termsAccepted: boolean;
  otpCode: string;
  otpSent: boolean;
  otpExpiresLabel?: string | null;
  requiresOtp: boolean;
  termsHref: string;
  showEmailForReject?: boolean;
  secondaryActions?: ReactNode;
  statusMessage?: string | null;
  onStartAccept: () => void;
  onStartReject: () => void;
  onReset: () => void;
  onNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onReasonChange: (value: string) => void;
  onTermsAcceptedChange: (value: boolean) => void;
  onOtpCodeChange: (value: string) => void;
  onRequestOtp: () => void;
  onAccept: () => void;
  onReject: () => void;
};

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function statusToneFor(message: string): QuoteResponseStatusTone {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("impossible") ||
    normalized.includes("n'a pas pu") ||
    normalized.includes("veuillez") ||
    normalized.includes("vous devez") ||
    normalized.includes("nécessaire") ||
    normalized.includes("requise")
  ) {
    return "error";
  }
  if (
    normalized.includes("enregistr") ||
    normalized.includes("envoy") ||
    normalized.includes("prépar") ||
    normalized.includes("copi")
  ) {
    return "success";
  }
  return "info";
}

export function QuoteResponsePanel({
  decision,
  summary,
  busy,
  name,
  email,
  reason,
  termsAccepted,
  otpCode,
  otpSent,
  otpExpiresLabel,
  requiresOtp,
  termsHref,
  showEmailForReject = false,
  secondaryActions,
  statusMessage,
  onStartAccept,
  onStartReject,
  onReset,
  onNameChange,
  onEmailChange,
  onReasonChange,
  onTermsAcceptedChange,
  onOtpCodeChange,
  onRequestOtp,
  onAccept,
  onReject,
}: QuoteResponsePanelProps) {
  const isBusy = busy !== null;
  const isAcceptFlow = decision === "accept";
  const isRejectFlow = decision === "reject";
  const showEmailField = isAcceptFlow || (isRejectFlow && showEmailForReject);
  const busyMessage =
    busy === "accept"
      ? "Validation du devis en cours…"
      : busy === "reject"
        ? "Enregistrement du refus en cours…"
        : busy === "otp"
          ? "Envoi du code en cours…"
          : null;
  const visibleStatusMessage = busyMessage || statusMessage || null;
  const statusTone = visibleStatusMessage ? (busyMessage ? "info" : statusToneFor(visibleStatusMessage)) : "info";
  const titleId = useId();

  function handleDecisionSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) {
      return;
    }
    if (isAcceptFlow) {
      onAccept();
      return;
    }
    onReject();
  }

  return (
    <section
      className={cx(styles.supportCard, styles.supportCardStrong, styles.quoteDecisionPanel)}
      aria-busy={isBusy}
      aria-labelledby={titleId}
      data-testid="quote-response-panel"
    >
      {decision === "none" ? (
        <>
          <div className={styles.quoteDecisionPanelHeader}>
            <h2 className={styles.quoteDecisionTitle} id={titleId}>
              Réponse au devis
            </h2>
          </div>

          <dl className={styles.quoteDecisionSummary} data-testid="quote-response-summary">
            {summary.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>

          <div className={styles.quoteDecisionChoices}>
            <button
              className={cx(styles.quoteDecisionChoice, styles.quoteDecisionChoiceAccept)}
              type="button"
              onClick={onStartAccept}
              disabled={isBusy}
              data-testid="quote-response-accept"
            >
              <span className={styles.quoteDecisionChoiceIcon}>
                <CheckCircle2 size={18} />
              </span>
              <span>Accepter</span>
              <ArrowRight className={styles.quoteDecisionChoiceArrow} size={16} />
            </button>

            <button
              className={cx(styles.quoteDecisionChoice, styles.quoteDecisionChoiceReject)}
              type="button"
              onClick={onStartReject}
              disabled={isBusy}
              data-testid="quote-response-reject"
            >
              <span className={styles.quoteDecisionChoiceIcon}>
                <XCircle size={18} />
              </span>
              <span>Refuser</span>
              <ArrowRight className={styles.quoteDecisionChoiceArrow} size={16} />
            </button>
          </div>

          {secondaryActions ? <div className={styles.quoteDecisionSecondaryActions}>{secondaryActions}</div> : null}
        </>
      ) : (
        <form className={styles.quoteDecisionFlow} data-testid="quote-response-form" onSubmit={handleDecisionSubmit}>
          <div className={cx(styles.quoteDecisionPanelHeader, styles.quoteDecisionFlowHeader)}>
            <div>
              <h2 className={styles.quoteDecisionTitle} id={titleId}>
                {isAcceptFlow ? "Accepter le devis" : "Refuser le devis"}
              </h2>
            </div>
            <button
              className={styles.quoteDecisionReset}
              type="button"
              onClick={onReset}
              disabled={isBusy}
              aria-label="Changer la réponse au devis"
            >
              Changer
            </button>
          </div>

          <div className={styles.quoteDecisionFields}>
            <label>
              Nom / société
              <input
                className="input"
                value={name}
                onChange={(event) => onNameChange(event.target.value)}
                placeholder="Nom Prénom"
                autoComplete="name"
                disabled={isBusy}
              />
            </label>

            {showEmailField ? (
              <label>
                Email {isAcceptFlow && requiresOtp ? "(requis)" : "(optionnel)"}
                <input
                  className="input"
                  value={email}
                  onChange={(event) => onEmailChange(event.target.value)}
                  placeholder="client@exemple.fr"
                  autoComplete="email"
                  inputMode="email"
                  disabled={isBusy}
                />
              </label>
            ) : null}
          </div>

          {isAcceptFlow ? (
            <>
              <label className={styles.quoteDecisionTerms}>
                <input
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={(event) => onTermsAcceptedChange(event.target.checked)}
                  disabled={isBusy}
                />
                <span>
                  J&apos;accepte les{" "}
                  <a href={termsHref} target="_blank" rel="noreferrer">
                    conditions de vente
                  </a>{" "}
                  applicables à ce devis.
                </span>
              </label>

              {requiresOtp ? (
                <div className={styles.quoteDecisionOtp}>
                  <p>Validation par code de confirmation requise.</p>
                  <button className={styles.quoteDecisionReset} type="button" onClick={onRequestOtp} disabled={isBusy}>
                    {busy === "otp" ? "Envoi…" : otpSent ? "Renvoyer le code" : "Recevoir un code"}
                  </button>
                  {otpExpiresLabel ? <small>Expire le {otpExpiresLabel}</small> : null}
                  <label>
                    Code de confirmation
                    <input
                      className="input"
                      value={otpCode}
                      onChange={(event) => onOtpCodeChange(event.target.value)}
                      placeholder="123456"
                      inputMode="numeric"
                      disabled={isBusy}
                    />
                  </label>
                </div>
              ) : null}
            </>
          ) : (
            <label className={styles.quoteDecisionSingleField}>
              Motif de refus (optionnel)
              <textarea
                className="input"
                value={reason}
                onChange={(event) => onReasonChange(event.target.value)}
                placeholder="Ex : budget, délais, périmètre..."
                disabled={isBusy}
              />
            </label>
          )}

          {visibleStatusMessage ? (
            <p
              className={cx(
                styles.quoteDecisionStatus,
                statusTone === "success" && styles.quoteDecisionStatusSuccess,
                statusTone === "error" && styles.quoteDecisionStatusError,
              )}
              role={statusTone === "error" ? "alert" : "status"}
              aria-live={statusTone === "error" ? "assertive" : "polite"}
              data-testid="quote-response-status"
            >
              {isBusy ? <span className={styles.quoteDecisionSpinner} aria-hidden="true" /> : null}
              <span>{visibleStatusMessage}</span>
            </p>
          ) : null}

          {isAcceptFlow ? (
            <button
              className={cx(styles.documentActionButton, styles.documentActionAccept)}
              type="submit"
              disabled={isBusy}
              data-testid="quote-response-submit"
            >
              {busy === "accept" ? "Validation…" : "Valider"}
            </button>
          ) : (
            <button
              className={cx(styles.documentActionButton, styles.documentActionReject)}
              type="submit"
              disabled={isBusy}
              data-testid="quote-response-submit"
            >
              {busy === "reject" ? "Enregistrement…" : "Confirmer le refus"}
            </button>
          )}
        </form>
      )}
    </section>
  );
}
