"use client";

import { sanitizeUserFacingApiMessage } from "@/lib/api";
import { UI_COPY_FR } from "@/lib/uiCopyFR";

const CSRF_CODES = new Set(["csrf_failed", "csrf_invalid", "csrf_origin", "csrf_origin_mismatch"]);

type ApiNoticeDetails = {
  message: string;
  actionLabel?: string;
  actionHref?: string;
};

const normalizeStatus = (status: unknown) => {
  const value = Number(status);
  return Number.isFinite(value) ? value : null;
};

export const getApiNotice = (error: any): ApiNoticeDetails | null => {
  const status = normalizeStatus(error?.status);
  if (!status) return null;
  if (![402, 403, 409].includes(status)) return null;
  const code = (error?.code || "").toString();
  if (status === 403 && CSRF_CODES.has(code)) return null;

  if (status === 402) {
    return {
      message: UI_COPY_FR.billingPaywall.title,
      actionLabel: UI_COPY_FR.billingPaywall.ctaChoosePlan,
      actionHref: "/app/billing/paywall",
    };
  }
  if (status === 403) {
    return {
      message: "Accès insuffisant.",
      actionLabel: "Contacter l'admin",
      actionHref: "/contact",
    };
  }
  const message = sanitizeUserFacingApiMessage(
    error?.message,
    status,
    "Cette action entre en conflit avec l’état actuel. Actualisez la page puis réessayez.",
  );
  return { message };
};

type ApiNoticeProps = {
  error?: any | null;
  className?: string;
};

export function ApiNotice({ error, className }: ApiNoticeProps) {
  const notice = getApiNotice(error);
  if (!notice) return null;
  const classes = ["alert-inline", "danger", "flex", "items-center", "gap-10", "flex-wrap", className]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} role="alert" aria-live="assertive">
      <span>{notice.message}</span>
      {notice.actionHref && notice.actionLabel && (
        <a className="btn secondary" href={notice.actionHref}>
          {notice.actionLabel}
        </a>
      )}
    </div>
  );
}
