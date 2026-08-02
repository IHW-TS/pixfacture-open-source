"use client";

import { Link } from "@/figma/react-router-compat";
import { ArrowRight, Lock } from "lucide-react";
import { useSession } from "@/lib/useSession";

type UpgradeNoticeCardProps = {
  title: string;
  description: string;
  ctaLabel?: string;
  ctaHref?: string;
  note?: string;
};

export function UpgradeNoticeCard({
  title,
  description,
  ctaLabel = "Passer au plan Pro",
  ctaHref = "/app/billing",
  note = "Disponible à partir du plan Pro.",
}: UpgradeNoticeCardProps) {
  const { user } = useSession({ autoRefresh: false });
  const canManageBilling =
    user?.is_admin === true || ["owner", "admin"].includes(String(user?.role || "").toLowerCase());
  const billingTarget = ctaHref === "/app/billing" || ctaHref.startsWith("/app/billing?");
  const showCta = !billingTarget || canManageBilling;

  return (
    <div className="rounded-xl border border-[#dbeafe] bg-[#f8fbff] p-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-[#eff6ff] text-[#1d4ed8]">
          <Lock className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="text-[#0f172a]" style={{ fontSize: "0.9375rem", fontWeight: 700 }}>
              {title}
            </h3>
            <span
              className="rounded-full bg-[#dbeafe] px-2 py-1 text-[#1d4ed8]"
              style={{ fontSize: "0.6875rem", fontWeight: 700 }}
            >
              Plan Pro
            </span>
          </div>
          <p className="text-[#475569]" style={{ fontSize: "0.8125rem", lineHeight: 1.6 }}>
            {description}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {showCta ? (
              <Link
                to={ctaHref}
                className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-white shadow-sm transition-all"
                style={{
                  fontSize: "0.8125rem",
                  fontWeight: 600,
                  background: "linear-gradient(135deg, #1d4ed8, #4f46e5)",
                }}
              >
                {ctaLabel} <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            ) : (
              <span
                className="inline-flex items-center rounded-lg border border-[#bfdbfe] bg-white px-3 py-2 text-[#1e40af]"
                style={{ fontSize: "0.8125rem", fontWeight: 600 }}
              >
                Demandez l’activation à un administrateur de votre espace.
              </span>
            )}
            <span className="text-[#64748b]" style={{ fontSize: "0.75rem" }}>
              {note}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
