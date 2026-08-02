"use client";

import { useEffect, useState } from "react";
import { Link } from "@/figma/react-router-compat";
import { api } from "@/lib/api";
import { NoticeBanner } from "./Feedback";

type SeqinoTokenNoticeProps = {
  enabled?: boolean;
  title?: string;
  className?: string;
};

export function SeqinoTokenNotice({
  enabled = true,
  title = "Solde de jetons insuffisant",
  className = "",
}: SeqinoTokenNoticeProps) {
  const [tokenState, setTokenState] = useState<any>(null);

  useEffect(() => {
    if (!enabled) {
      setTokenState(null);
      return;
    }
    let active = true;
    api("/api/tokens/state", { method: "GET" })
      .then((payload) => {
        if (!active) return;
        setTokenState(payload || null);
      })
      .catch(() => {
        if (!active) return;
        setTokenState(null);
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  if (!enabled) return null;
  const balance = Number(tokenState?.balance || 0);
  if (!tokenState || Number.isNaN(balance) || balance > 0) return null;
  const ctaHref =
    typeof tokenState?.topup_cta === "string" && tokenState.topup_cta ? tokenState.topup_cta : "/app/billing";

  return (
    <NoticeBanner
      tone="warning"
      title={title}
      className={className}
      action={
        <Link
          to={ctaHref}
          className="inline-flex items-center rounded-lg bg-[#fff7ed] px-3 py-2 text-[#9a3412] transition-colors hover:bg-[#ffedd5]"
          style={{ fontSize: "0.75rem", fontWeight: 700 }}
        >
          Acheter des jetons
        </Link>
      }
    >
      Le plan Pro est actif, mais il ne reste plus de jetons pour lancer une nouvelle transmission. Achetez un pack pour
      reprendre les transmissions connectées.
    </NoticeBanner>
  );
}
