"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UI_COPY_FR } from "@/lib/uiCopyFR";
import { api, formatApiError } from "@/lib/api";
import { fetchBillingStatus } from "@/lib/billingApi";
import { getLegalConfig } from "@/lib/legalConfig";
import { logout } from "@/lib/authCookies";

export default function BillingPaywall() {
  const router = useRouter();
  const { supportEmail } = getLegalConfig();
  const [portalLoading, setPortalLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const status = await fetchBillingStatus();
      if (!status) {
        throw new Error("Statut indisponible.");
      }
    } catch (err: unknown) {
      setError(formatApiError(err, "Actualisation impossible."));
    } finally {
      setRefreshing(false);
    }
  };

  const mailtoSupport = `mailto:${supportEmail}`;
  const checkoutUrl = "/app/billing?checkout=1&plan=pro&period=monthly";

  return (
    <div className="card grid-simple gap-12">
      <div>
        <h1 className="mb-6">{UI_COPY_FR.billingPaywall.title}</h1>
        <div className="muted">{UI_COPY_FR.billingPaywall.subtitle}</div>
      </div>
      <p className="muted m-0">{UI_COPY_FR.billingPaywall.body}</p>
      <div className="notice">{UI_COPY_FR.billingPaywall.tipJustPaid}</div>
      {error ? (
        <div className="alert-inline danger" role="status">
          {error}
        </div>
      ) : null}
      <div className="row gap-10 flex-wrap">
        <button className="btn" type="button" onClick={() => router.push(checkoutUrl)}>
          {UI_COPY_FR.billingPaywall.ctaCheckoutPro}
        </button>
        <button className="btn secondary" type="button" onClick={() => router.push("/pricing")}>
          {UI_COPY_FR.billingPaywall.ctaChoosePlan}
        </button>
        <button className="btn secondary" type="button" onClick={openPortal} disabled={portalLoading}>
          {UI_COPY_FR.billingPaywall.ctaManage}
        </button>
        <button className="btn ghost" type="button" onClick={handleRefresh} disabled={refreshing}>
          {UI_COPY_FR.billingPaywall.ctaRefresh}
        </button>
        <a className="btn ghost" href={mailtoSupport}>
          {UI_COPY_FR.billingPaywall.ctaSupport}
        </a>
      </div>
      <div className="muted text-13">{UI_COPY_FR.billingPaywall.smallPrint}</div>
    </div>
  );
}
