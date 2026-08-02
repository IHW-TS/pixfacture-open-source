"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "analytics_consent";
const OPEN_EVENT = "cookie-consent-open";

type ConsentState = "granted" | "denied" | null;

const formatConsent = (value: ConsentState) => {
  if (value === "granted") return "autorise";
  if (value === "denied") return "refuse";
  return "non defini";
};

export default function CookieConsentManager() {
  const [consent, setConsent] = useState<ConsentState>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    setConsent(stored === "granted" || stored === "denied" ? stored : null);
  }, []);

  const reset = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setConsent(null);
    window.dispatchEvent(new Event(OPEN_EVENT));
  };

  return (
    <div className="alert-inline grid-simple gap-6">
      <strong>Gestion consentement analytics</strong>
      <div className="muted">Statut actuel : {formatConsent(consent)}</div>
      <div className="row gap-8">
        <button type="button" className="btn secondary" onClick={reset}>
          Modifier mes choix
        </button>
      </div>
    </div>
  );
}
