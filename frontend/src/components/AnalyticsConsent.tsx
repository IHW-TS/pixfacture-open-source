"use client";

import { useEffect, useMemo, useState } from "react";
import Script from "next/script";
import Link from "next/link";

const STORAGE_KEY = "analytics_consent";
const OPEN_EVENT = "cookie-consent-open";

type ConsentState = "granted" | "denied" | null;

type AnalyticsConsentProps = {
  plausibleDomain?: string | null;
};

const normalizeConsent = (value: string | null): ConsentState => {
  if (!value) return null;
  if (value === "granted") return "granted";
  if (value === "denied") return "denied";
  return null;
};

const isConsentRequired = (value: string | undefined) => {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(normalized);
};

export default function AnalyticsConsent({ plausibleDomain }: AnalyticsConsentProps) {
  const [consent, setConsent] = useState<ConsentState>(null);
  const consentRequired = isConsentRequired(process.env.NEXT_PUBLIC_ANALYTICS_CONSENT_REQUIRED);
  const providerLabel = (process.env.NEXT_PUBLIC_ANALYTICS_PROVIDER || "Mesure audience").trim();
  const hasAnalytics = Boolean(plausibleDomain);

  useEffect(() => {
    if (!hasAnalytics || !consentRequired) return;
    const stored = normalizeConsent(window.localStorage.getItem(STORAGE_KEY));
    setConsent(stored);
  }, [hasAnalytics, consentRequired]);

  useEffect(() => {
    if (!hasAnalytics || !consentRequired) return undefined;
    const handleOpen = () => {
      setConsent(null);
    };
    window.addEventListener(OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(OPEN_EVENT, handleOpen);
  }, [hasAnalytics, consentRequired]);

  const shouldLoadScript = useMemo(() => {
    if (!hasAnalytics) return false;
    if (!consentRequired) return true;
    return consent === "granted";
  }, [hasAnalytics, consentRequired, consent]);

  const accept = () => {
    window.localStorage.setItem(STORAGE_KEY, "granted");
    setConsent("granted");
  };

  const refuse = () => {
    window.localStorage.setItem(STORAGE_KEY, "denied");
    setConsent("denied");
  };

  return (
    <>
      {shouldLoadScript ? (
        <Script
          data-domain={plausibleDomain || undefined}
          src="https://plausible.io/js/script.js"
          strategy="afterInteractive"
        />
      ) : null}
      {hasAnalytics && consentRequired && consent === null && (
        <div className="alert-inline mt-12 mb-12">
          <div className="grid-simple gap-6">
            <strong>Consentement cookies</strong>
            <div className="muted">
              {providerLabel} est active. Autoriser la mesure d'audience (cookies optionnels) ?
            </div>
            <div className="row gap-8">
              <button type="button" className="btn" onClick={accept}>
                Autoriser
              </button>
              <button type="button" className="btn secondary" onClick={refuse}>
                Refuser
              </button>
              <Link className="btn ghost" href="/legal/cookies">
                En savoir plus
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
