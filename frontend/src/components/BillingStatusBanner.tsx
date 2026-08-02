"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { UI_COPY_FR } from "@/lib/uiCopyFR";
import { api, formatApiError } from "@/lib/api";
import { logout } from "@/lib/authCookies";

type BillingStatusBannerProps = {
  status?: string | null;
  trialEnd?: string | null;
  periodEnd?: string | null;
  onRefresh?: () => Promise<void> | void;
};

const DEFAULT_PAST_DUE_DAYS_LEFT = 3;

const normalizeStatus = (value?: string | null) => {
  if (!value) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
};

const formatDate = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("fr-FR").format(date);
};

export default function BillingStatusBanner({ status, trialEnd, periodEnd, onRefresh }: BillingStatusBannerProps) {
  const router = useRouter();
  const [portalLoading, setPortalLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = normalizeStatus(status);
  const trialEndLocal = formatDate(trialEnd);
  const periodEndLocal = formatDate(periodEnd);

  const message = useMemo(() => {
    if (!normalized) return null;
    if (normalized === "trialing" && trialEndLocal) {
      return UI_COPY_FR.billingBanner.trialing(trialEndLocal);
    }
    if (normalized === "cancel_at_period_end" && periodEndLocal) {
      return UI_COPY_FR.billingBanner.cancelAtPeriodEnd(periodEndLocal);
    }
    if (normalized === "past_due") {
      return UI_COPY_FR.billingBanner.pastDue(DEFAULT_PAST_DUE_DAYS_LEFT);
    }
    if (normalized === "unpaid") {
      return UI_COPY_FR.billingBanner.unpaid;
    }
    if (["canceled", "cancelled", "inactive", "inactif"].includes(normalized)) {
      return UI_COPY_FR.billingBanner.canceled;
    }
    return null;
  }, [normalized, periodEndLocal, trialEndLocal]);

  const isPastDue = normalized === "past_due";
  const isUnpaid = normalized === "unpaid";
  const isCanceled = ["canceled", "cancelled", "inactive", "inactif"].includes(normalized);
  const showOpenBilling = Boolean(message);
  const showRefresh = Boolean(message && onRefresh);

  const openPortal = async () => {
    if (portalLoading) return;
    setPortalLoading(true);
    setError(null);
    try {
      const r = (await api("/api/billing/portal", { method: "GET" })) as { url?: string };
      if (!r?.url) throw new Error("Le portail de paiement est temporairement indisponible.");
      window.location.href = r.url;
    } catch (e: unknown) {
      const err = e as { message?: string };
      const rawMessage = typeof err?.message === "string" ? err.message : "";
      if (rawMessage.includes("Token invalide")) {
        logout();
        window.location.href = "/app/login?next=/app/billing";
        return;
      }
      setError(formatApiError(err, "Impossible d’ouvrir le portail de paiement."));
    } finally {
      setPortalLoading(false);
    }
  };

  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      await onRefresh();
    } catch (err: unknown) {
      setError(formatApiError(err, "Actualisation impossible."));
    } finally {
      setRefreshing(false);
    }
  };

  if (!message) return null;

  return (
    <div className="notice mb-12 grid-simple gap-10">
      <div>{message}</div>
      {error ? (
        <div className="alert-inline danger" role="status">
          {error}
        </div>
      ) : null}
      <div className="flex gap-10 flex-wrap">
        {(isPastDue || isUnpaid) && (
          <button className="btn" type="button" onClick={openPortal} disabled={portalLoading}>
            {UI_COPY_FR.billingBanner.ctaUpdatePayment}
          </button>
        )}
        {isCanceled && (
          <button className="btn" type="button" onClick={() => router.push("/pricing")}>
            {UI_COPY_FR.billingBanner.ctaReactivate}
          </button>
        )}
        {showOpenBilling && (
          <a className="btn secondary" href="/app/billing">
            {UI_COPY_FR.billingBanner.ctaOpenBilling}
          </a>
        )}
        {showRefresh && (
          <button className="btn ghost" type="button" onClick={handleRefresh} disabled={refreshing}>
            {UI_COPY_FR.billingBanner.ctaRefresh}
          </button>
        )}
      </div>
    </div>
  );
}
