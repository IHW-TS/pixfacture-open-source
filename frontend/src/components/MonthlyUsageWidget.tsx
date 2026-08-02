"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiFetch, formatApiError } from "@/lib/api";
import { pdpIntegrationEnabled } from "@/lib/featureFlags";

type UsageSummary = {
  period: string;
  plan: string;
  used_flows: number;
  remaining: number | null;
  overage_rate_eur: number;
  seqino_mandate_active: boolean;
};

type TokenState = {
  balance: number;
  welcome_bonus_granted?: boolean;
};

type MonthlyUsageWidgetProps = {
  className?: string;
};

const checkoutRequestId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const formatUsageSummary = (used: number) => {
  return `${used} transmissions suivies sur la période`;
};

export default function MonthlyUsageWidget({ className }: MonthlyUsageWidgetProps) {
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [tokenState, setTokenState] = useState<TokenState | null>(null);
  const [usageError, setUsageError] = useState(false);
  const [usageLoading, setUsageLoading] = useState(false);
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupQuantity, setTopupQuantity] = useState(1000);
  const [topupLoading, setTopupLoading] = useState(false);
  const [topupError, setTopupError] = useState<string | null>(null);
  const isMounted = useRef(true);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    setUsageError(false);
    try {
      const u = await api("/api/usage/summary", {});
      const tokens = await api("/api/tokens/state", {}).catch(() => null);
      if (!isMounted.current) return;
      setUsageSummary(u as UsageSummary);
      setTokenState(tokens as TokenState | null);
    } catch (e) {
      if (!isMounted.current) return;
      setUsageSummary(null);
      setTokenState(null);
      setUsageError(true);
    } finally {
      if (!isMounted.current) return;
      setUsageLoading(false);
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    loadUsage();
    return () => {
      isMounted.current = false;
    };
  }, [loadUsage]);

  useEffect(() => {
    if (!topupOpen) return;
    if (typeof document === "undefined") return;
    document.body.classList.add("no-scroll");
    return () => {
      document.body.classList.remove("no-scroll");
    };
  }, [topupOpen]);

  const wrapperClass = ["notice", "mt-12", className].filter(Boolean).join(" ");
  const platformLabel = pdpIntegrationEnabled
    ? usageSummary?.seqino_mandate_active
      ? "actif"
      : "à activer"
    : "non activé";
  const platformCta = usageSummary?.seqino_mandate_active
    ? { label: "Gérer le mandat", href: "/app/einvoicing" }
    : { label: "Configurer la plateforme partenaire", href: "/app/einvoicing" };

  const isPro = (usageSummary?.plan || "").toLowerCase() === "pro";
  const tokenBalance = Number(tokenState?.balance || 0);
  const canBuyTopup = isPro;

  const topupOptions = [100, 500, 1000, 5000];

  const startTopupCheckout = async () => {
    if (topupLoading) return;
    setTopupLoading(true);
    setTopupError(null);
    try {
      const res = await apiFetch("/api/tokens/checkout", {
        method: "POST",
        body: JSON.stringify({ pack: String(topupQuantity), checkout_request_id: checkoutRequestId() }),
      });
      if (res?.url) {
        window.location.href = res.url;
        return;
      }
      setTopupError("URL de paiement indisponible.");
    } catch (e: any) {
      setTopupError(formatApiError(e, "Paiement indisponible."));
    } finally {
      setTopupLoading(false);
    }
  };

  return (
    <div className={wrapperClass}>
      <div className="row justify-between gap-8">
        <div className="font-600">Jetons de transmission</div>
        <button type="button" className="btn secondary btn-sm" onClick={loadUsage} disabled={usageLoading}>
          Rafraîchir
        </button>
      </div>
      {usageError ? (
        <div className="muted">Consommation indisponible pour le moment.</div>
      ) : usageSummary ? (
        <div className="grid-simple gap-6">
          <div>{formatUsageSummary(usageSummary.used_flows)}</div>
          <div className="row gap-16 flex-wrap">
            <span>
              Jetons disponibles : <b>{tokenBalance}</b>
            </span>
            <span>
              Transmissions suivies : <b>{usageSummary.used_flows}</b>
            </span>
            <span>
              Bonus Pro : <b>{tokenState?.welcome_bonus_granted ? "attribué" : "en attente"}</b>
            </span>
          </div>
          <div className="row gap-10 flex-wrap">
            <span>
              Mandat PA : <b>{platformLabel}</b>
            </span>
            {pdpIntegrationEnabled && (
              <a className="btn secondary btn-sm" href={platformCta.href}>
                {platformCta.label}
              </a>
            )}
          </div>
          {canBuyTopup && (
            <div className="row gap-10 flex-wrap items-center">
              <span className="muted">Besoin de jetons d’envoi ?</span>
              <button
                className="btn secondary btn-sm"
                type="button"
                onClick={() => {
                  setTopupError(null);
                  setTopupOpen(true);
                }}
              >
                Acheter des jetons
              </button>
            </div>
          )}
        </div>
      ) : usageLoading ? (
        <div className="muted">Chargement…</div>
      ) : null}

      {topupOpen && (
        <div role="dialog" aria-modal="true" aria-label="Achat de jetons" className="modal-overlay ui-overlay z-70">
          <div className="card max-w-420 w-full grid-simple gap-12">
            <div className="panel__header flex items-center justify-between">
              <h3 className="m-0">Acheter des jetons</h3>
              <button
                className="icon-button"
                aria-label="Fermer"
                type="button"
                onClick={() => {
                  setTopupOpen(false);
                  setTopupError(null);
                }}
              >
                ✕
              </button>
            </div>
            <div className="muted">Choisissez une recharge pour vos jetons de transmission.</div>
            <label>
              Pack
              <select
                className="input"
                value={topupQuantity}
                onChange={(e) => setTopupQuantity(Number(e.target.value))}
              >
                {topupOptions.map((option) => (
                  <option key={option} value={option}>
                    {option} jetons
                  </option>
                ))}
              </select>
            </label>
            {topupError && <div className="alert-inline danger">{topupError}</div>}
            <div className="row gap-10 flex-wrap justify-end">
              <button
                className="btn ghost"
                type="button"
                onClick={() => {
                  setTopupOpen(false);
                  setTopupError(null);
                }}
                disabled={topupLoading}
              >
                Annuler
              </button>
              <button
                className={`btn${topupLoading ? " is-loading" : ""}`}
                type="button"
                onClick={startTopupCheckout}
                disabled={topupLoading}
                aria-busy={topupLoading}
              >
                <span className="btn__label">Aller au paiement</span>
                <span className="btn-spinner btn__spinner" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
