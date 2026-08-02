"use client";

import { isSubscriptionBlocked } from "@/lib/subscriptionGate";

type SubscriptionCtaNoticeProps = {
  status?: string | null;
  title?: string;
  description?: string;
  ctaLabel?: string;
  ctaHref?: string;
};

export default function SubscriptionCtaNotice({
  status,
  title = "Abonnement requis",
  description = "Cette fonctionnalité est réservée aux espaces avec abonnement actif.",
  ctaLabel = "S'abonner",
  ctaHref = "/app/billing",
}: SubscriptionCtaNoticeProps) {
  if (!isSubscriptionBlocked(status)) return null;

  return (
    <div className="notice mb-12 grid-simple gap-10">
      <div>
        <strong>{title}</strong>
        <div className="muted">{description}</div>
      </div>
      <div className="row gap-10 flex-wrap">
        <a className="btn" href={ctaHref}>
          {ctaLabel}
        </a>
      </div>
    </div>
  );
}
