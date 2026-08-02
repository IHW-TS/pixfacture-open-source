"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { UI_COPY_FR } from "@/lib/uiCopyFR";
import { getLegalConfig, getLegalDocVersion, isLegalValueMissing } from "@/lib/legalConfig";
import { useAnimatedPresence } from "@/lib/useAnimatedPresence";

type LegalDoc = {
  slug: string;
  version: string;
  url?: string;
};

type BillingLegalAcceptanceModalProps = {
  open: boolean;
  docs: LegalDoc[];
  submitting?: boolean;
  error?: string | null;
  onAccept: (docs: LegalDoc[]) => void;
  onCancel: () => void;
};

const docKey = (doc: LegalDoc) => `${doc.slug}:${doc.version}`;

const resolveDocVersion = (envValue: string, fallback: string | undefined) => {
  if (!isLegalValueMissing(envValue)) return envValue;
  return fallback || envValue;
};

export default function BillingLegalAcceptanceModal({
  open,
  docs,
  submitting = false,
  error,
  onAccept,
  onCancel,
}: BillingLegalAcceptanceModalProps) {
  const { mounted, state } = useAnimatedPresence(open, { exitMs: 180 });
  const { companyName } = getLegalConfig();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [localError, setLocalError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  const versions = useMemo(() => {
    const termsDoc = docs.find((doc) => doc.slug === "terms");
    const dpaDoc = docs.find((doc) => doc.slug === "dpa");
    const termsEnv = getLegalDocVersion("terms");
    const dpaEnv = getLegalDocVersion("dpa");
    return {
      terms: resolveDocVersion(termsEnv, termsDoc?.version),
      dpa: resolveDocVersion(dpaEnv, dpaDoc?.version),
    };
  }, [docs]);

  useEffect(() => {
    if (!open) return;
    const nextChecked: Record<string, boolean> = {};
    docs.forEach((doc) => {
      nextChecked[docKey(doc)] = false;
    });
    setChecked(nextChecked);
    setLocalError(null);
  }, [docs, open]);

  useEffect(() => {
    if (!mounted) return;
    if (typeof document === "undefined") return;
    document.body.classList.add("no-scroll");
    return () => {
      document.body.classList.remove("no-scroll");
    };
  }, [mounted]);

  useEffect(() => {
    if (!mounted || typeof document === "undefined") return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => {
      const cancelButton = cancelButtonRef.current;
      if (cancelButton && !cancelButton.disabled) {
        cancelButton.focus();
        return;
      }
      const firstCheckbox = dialogRef.current?.querySelector<HTMLElement>('input[type="checkbox"]:not([disabled])');
      (firstCheckbox || dialogRef.current)?.focus();
    }, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        onCancel();
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
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [mounted, onCancel, submitting]);

  if (!mounted) return null;

  const canContinue = docs.every((doc) => checked[docKey(doc)]);

  const handleContinue = () => {
    if (!canContinue) {
      setLocalError(UI_COPY_FR.legalAcceptanceModal.errorMustAccept);
      return;
    }
    setLocalError(null);
    onAccept(docs);
  };

  const resolveCheckboxLabel = (doc: LegalDoc) => {
    if (doc.slug === "terms") {
      return UI_COPY_FR.legalAcceptanceModal.checkboxTerms(versions.terms);
    }
    if (doc.slug === "dpa") {
      return UI_COPY_FR.legalAcceptanceModal.checkboxDpa(versions.dpa);
    }
    return `${doc.slug} — version ${doc.version}`;
  };

  const displayError = localError || error;

  return (
    <div
      data-testid="stripe-legal-acceptance-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Acceptation des documents légaux"
      className="modal-overlay ui-overlay"
      data-state={state}
    >
      <div ref={dialogRef} tabIndex={-1} className="card ui-dialog max-w-640 w-full grid-simple gap-16">
        <div>
          <h2 className="mt-6">{UI_COPY_FR.legalAcceptanceModal.title}</h2>
          <p className="muted mt-6">{UI_COPY_FR.legalAcceptanceModal.intro}</p>
        </div>

        <div className="grid-simple gap-10">
          <div className="font-600">{UI_COPY_FR.legalAcceptanceModal.documentsTitle}</div>
          {docs.map((doc) => {
            const key = docKey(doc);
            return (
              <label key={key} className="flex gap-10 items-start">
                <input
                  type="checkbox"
                  checked={Boolean(checked[key])}
                  onChange={(event) => {
                    setChecked((prev) => ({ ...prev, [key]: event.target.checked }));
                    setLocalError(null);
                  }}
                />
                <span>
                  {resolveCheckboxLabel(doc)}
                  {doc.url ? (
                    <>
                      {" "}
                      <a href={doc.url} target="_blank" rel="noreferrer">
                        Lire le document
                      </a>
                    </>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>

        <div className="notice grid-simple gap-6">
          <div className="font-600">{UI_COPY_FR.legalAcceptanceModal.einvoicingTitle}</div>
          <div>{UI_COPY_FR.legalAcceptanceModal.einvoicingBody(companyName)}</div>
        </div>

        <div className="muted text-13">{UI_COPY_FR.legalAcceptanceModal.footer}</div>

        {displayError ? (
          <div className="alert-inline danger" role="alert">
            {displayError}
          </div>
        ) : null}

        <div className="flex gap-12 justify-end">
          <button
            ref={cancelButtonRef}
            className="btn secondary"
            type="button"
            onClick={onCancel}
            disabled={submitting}
          >
            {UI_COPY_FR.legalAcceptanceModal.ctaCancel}
          </button>
          <button className="btn" type="button" onClick={handleContinue} disabled={submitting}>
            {UI_COPY_FR.legalAcceptanceModal.ctaContinue}
          </button>
        </div>
      </div>
    </div>
  );
}
