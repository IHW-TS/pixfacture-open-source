"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, formatApiError } from "@/lib/api";

type LegalDoc = {
  slug: string;
  version: string;
  document_sha256?: string;
  url?: string;
  acceptance_scope?: "user" | "tenant";
  can_accept?: boolean;
};

type LegalRequiredResponse = {
  required: LegalDoc[];
  alreadyAccepted: LegalDoc[];
};

const DOC_LABELS: Record<string, string> = {
  terms: "CGV/CGU",
  dpa: "DPA (annexe RGPD)",
};

const docKey = (doc: LegalDoc) => `${doc.slug}:${doc.version}:${doc.document_sha256 || "legacy"}`;

export default function LegalAcceptanceGuard({ active, userKey }: { active: boolean; userKey?: string | null }) {
  const [required, setRequired] = useState<LegalDoc[]>([]);
  const [accepted, setAccepted] = useState<LegalDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const fetchedRef = useRef(false);
  const lastUserRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const pendingDocs = useMemo(() => {
    if (!required.length) return [];
    const acceptedKeys = new Set(accepted.map(docKey));
    return required.filter((doc) => !acceptedKeys.has(docKey(doc)));
  }, [required, accepted]);

  const pendingKey = pendingDocs.map(docKey).join("|");

  useEffect(() => {
    if (!pendingDocs.length) return;
    const nextChecked: Record<string, boolean> = {};
    pendingDocs.forEach((doc) => {
      nextChecked[docKey(doc)] = false;
    });
    setChecked(nextChecked);
  }, [pendingKey, pendingDocs]);

  useEffect(() => {
    if (!userKey) {
      fetchedRef.current = false;
      lastUserRef.current = null;
      setRequired([]);
      setAccepted([]);
      setChecked({});
      setError(null);
      return;
    }
    if (userKey !== lastUserRef.current) {
      lastUserRef.current = userKey;
      fetchedRef.current = false;
      setRequired([]);
      setAccepted([]);
      setChecked({});
      setError(null);
    }
  }, [userKey]);

  useEffect(() => {
    if (!active) return;
    if (loading) return;
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);
    setError(null);
    api("/api/legal/required")
      .then((res: LegalRequiredResponse) => {
        setRequired(res.required || []);
        setAccepted(res.alreadyAccepted || []);
      })
      .catch((err) => {
        setRequired([]);
        setAccepted([]);
        setError(formatApiError(err, "Vérification des documents légaux impossible."));
      })
      .finally(() => setLoading(false));
  }, [active, loading, reloadKey]);

  useEffect(() => {
    if (!active || (!pendingDocs.length && !error)) return;
    if (typeof document === "undefined") return;
    document.body.classList.add("no-scroll");
    return () => {
      document.body.classList.remove("no-scroll");
    };
  }, [active, error, pendingKey, pendingDocs.length]);

  useEffect(() => {
    if (!active || (!pendingDocs.length && !error) || typeof document === "undefined") return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusFirst = () => {
      const first = dialogRef.current?.querySelector<HTMLElement>(focusableSelector);
      (first || dialogRef.current)?.focus();
    };
    const timer = window.setTimeout(focusFirst, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) || []).filter(
        (node) => node.offsetParent !== null,
      );
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
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
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [active, error, pendingKey, pendingDocs.length]);

  if (!active) return null;
  if (!pendingDocs.length && !error) return null;

  const verificationFailed = Boolean(error && !pendingDocs.length);
  const delegatedDocs = pendingDocs.filter((doc) => doc.can_accept === false);
  const canContinue =
    !verificationFailed && delegatedDocs.length === 0 && pendingDocs.every((doc) => checked[docKey(doc)]);

  const handleRetry = () => {
    fetchedRef.current = false;
    setError(null);
    setReloadKey((value) => value + 1);
  };

  const handleAccept = async () => {
    if (!canContinue || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      for (const doc of pendingDocs) {
        await api("/api/legal/accept", {
          method: "POST",
          body: JSON.stringify({ slug: doc.slug, version: doc.version }),
        });
      }
      const res: LegalRequiredResponse = await api("/api/legal/required");
      setRequired(res.required || []);
      setAccepted(res.alreadyAccepted || []);
    } catch (err) {
      setError(formatApiError(err, "Enregistrement de l'acceptation impossible."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="legal-acceptance-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Acceptation des documents légaux"
      className="modal-overlay ui-overlay"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-full max-w-[560px] rounded-[28px] border border-[#dbe4f0] bg-white p-6 shadow-[0_28px_70px_-30px_rgba(15,23,42,0.52)] sm:p-7"
      >
        <div>
          <div className="inline-flex items-center rounded-full border border-[#dbeafe] bg-[#eff6ff] px-3 py-1 text-[0.72rem] font-bold uppercase tracking-[0.08em] text-[#1d4ed8]">
            Obligatoire
          </div>
          <h2 className="mt-4 text-[1.35rem] font-bold leading-tight text-[#0f172a]">
            {verificationFailed ? "Vérification légale indisponible" : "Acceptation des documents légaux"}
          </h2>
          <p className="mt-2 text-[0.95rem] leading-7 text-[#475569]">
            {verificationFailed
              ? "Nous devons vérifier les documents légaux avant de vous laisser accéder à l'application."
              : delegatedDocs.length
                ? "Le DPA engage votre entreprise. Un propriétaire ou administrateur doit l'accepter avant que l'équipe puisse continuer."
                : "Pour continuer, merci de valider les documents suivants. Une preuve d’acceptation (date, adresse IP et navigateur) est enregistrée."}
          </p>
        </div>

        {!verificationFailed ? (
          <div className="mt-6 grid gap-3">
            {pendingDocs.map((doc) => {
              const label = DOC_LABELS[doc.slug] || doc.slug;
              const key = docKey(doc);
              return (
                <label
                  key={key}
                  className="flex cursor-pointer items-start gap-3 rounded-2xl border border-[#dbe4f0] bg-[#f8fafc] px-4 py-3.5 text-[#172033] transition hover:border-[#bfdbfe] hover:bg-[#eff6ff]"
                >
                  <input
                    type="checkbox"
                    checked={Boolean(checked[key])}
                    onChange={(event) => {
                      setChecked((prev) => ({ ...prev, [key]: event.target.checked }));
                    }}
                    className="mt-0.5 h-4 w-4 rounded border-[#94a3b8] text-[#2563eb] accent-[#2563eb]"
                    disabled={doc.can_accept === false}
                  />
                  <span className="min-w-0 text-[0.92rem] font-semibold leading-6">
                    {doc.can_accept === false ? "Acceptation par un administrateur requise : " : "J'accepte "}
                    {label} (version {doc.version})
                    {doc.url ? (
                      <>
                        {" "}
                        <a
                          className="text-[#1d4ed8] underline-offset-4 hover:underline"
                          href={doc.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Lire le document
                        </a>
                      </>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        ) : null}

        {error ? (
          <div
            className="mt-4 rounded-2xl border border-[#fecaca] bg-[#fef2f2] px-4 py-3 text-[0.9rem] font-semibold text-[#b91c1c]"
            role="status"
          >
            {error}
          </div>
        ) : null}

        <div className="mt-6 flex justify-end gap-3 border-t border-[#e2e8f0] pt-5">
          {verificationFailed ? (
            <>
              <a
                className="inline-flex min-h-11 items-center justify-center rounded-2xl border border-[#dbe4f0] bg-white px-5 text-[0.95rem] font-bold text-[#475569] transition hover:bg-[#f8fafc]"
                href="/app/logout"
              >
                Se déconnecter
              </a>
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-2xl bg-[#2563eb] px-5 text-[0.95rem] font-bold text-white shadow-[0_14px_26px_-18px_rgba(37,99,235,0.95)] transition hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:bg-[#94a3b8] disabled:shadow-none"
                type="button"
                onClick={handleRetry}
                disabled={loading}
              >
                {loading ? "Vérification..." : "Réessayer"}
              </button>
            </>
          ) : (
            <>
              {delegatedDocs.length ? (
                <a
                  className="inline-flex min-h-11 items-center justify-center rounded-2xl border border-[#dbe4f0] bg-white px-5 text-[0.95rem] font-bold text-[#475569] transition hover:bg-[#f8fafc]"
                  href="/app/logout"
                >
                  Se déconnecter
                </a>
              ) : null}
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-2xl bg-[#2563eb] px-5 text-[0.95rem] font-bold text-white shadow-[0_14px_26px_-18px_rgba(37,99,235,0.95)] transition hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:bg-[#94a3b8] disabled:shadow-none"
                type="button"
                onClick={delegatedDocs.length ? handleRetry : handleAccept}
                disabled={delegatedDocs.length ? loading : !canContinue || submitting}
              >
                {delegatedDocs.length
                  ? loading
                    ? "Actualisation..."
                    : "Actualiser"
                  : submitting
                    ? "Enregistrement..."
                    : "Accepter et continuer"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
