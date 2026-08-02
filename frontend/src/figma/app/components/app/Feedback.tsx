"use client";

import { useEffect } from "react";
import { AlertCircle, CheckCircle2, Inbox, Info, LoaderCircle, X, XCircle } from "lucide-react";
import { Card } from "./AppPageHeader";

type BannerTone = "success" | "danger" | "warning" | "info";
type BannerVariant = "success" | "danger" | "warn" | "info";

/* ── Skeleton primitives ─────────────────────────────── */

function Shimmer({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-[#e2e8f0] dark:bg-white/10 ${className}`} />;
}

export function SkeletonStatCards({ count = 4 }: { count?: number }) {
  return (
    <div className={`grid grid-cols-2 xl:grid-cols-${count} gap-4`}>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <div className="space-y-3">
            <Shimmer className="h-2 w-16" />
            <Shimmer className="h-6 w-24" />
            <Shimmer className="h-2 w-20" />
          </div>
        </Card>
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 5, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <Card padding={false}>
      <div className="px-5 py-3.5 border-b border-[#e2e8f0]">
        <div className="flex gap-6">
          {Array.from({ length: cols }).map((_, i) => (
            <Shimmer key={i} className="h-2 w-16" />
          ))}
        </div>
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-6 px-5 py-3 border-b border-[#f1f5f9] last:border-0">
          {Array.from({ length: cols }).map((_, c) => (
            <Shimmer key={c} className={`h-3 ${c === 0 ? "w-32" : "w-16"}`} />
          ))}
        </div>
      ))}
    </Card>
  );
}

export function SkeletonPage({ statCards = 4, tableRows = 5 }: { statCards?: number; tableRows?: number }) {
  return (
    <div className="space-y-5 p-5 lg:p-7">
      <div className="w-full space-y-5">
        <SkeletonStatCards count={statCards} />
        <div className="flex gap-2">
          {[1, 2, 3].map((i) => (
            <Shimmer key={i} className="h-7 w-20 rounded-md" />
          ))}
        </div>
        <SkeletonTable rows={tableRows} />
      </div>
    </div>
  );
}

export function NoticeBanner({
  tone = "info",
  variant,
  title,
  children,
  action,
  className = "",
  onDismiss,
  autoDismissMs,
}: {
  tone?: BannerTone;
  variant?: BannerVariant;
  title?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  onDismiss?: () => void;
  autoDismissMs?: number;
}) {
  const resolvedTone =
    variant === "warn" ? "warning" : variant === "danger" ? "danger" : variant === "success" ? "success" : tone;

  const config = {
    info: {
      bg: "#eff6ff",
      border: "#bfdbfe",
      icon: Info,
      iconColor: "#1d4ed8",
      textColor: "#1e40af",
    },
    warning: {
      bg: "#fffbeb",
      border: "#fde68a",
      icon: AlertCircle,
      iconColor: "#d97706",
      textColor: "#92400e",
    },
    danger: {
      bg: "#fef2f2",
      border: "#fecaca",
      icon: XCircle,
      iconColor: "#dc2626",
      textColor: "#991b1b",
    },
    success: {
      bg: "#f0fdf4",
      border: "#bbf7d0",
      icon: CheckCircle2,
      iconColor: "#16a34a",
      textColor: "#14532d",
    },
  }[resolvedTone];
  const Icon = config.icon;
  const toneClass = resolvedTone === "warning" ? "warning" : resolvedTone;
  useEffect(() => {
    if (!onDismiss || !autoDismissMs || autoDismissMs <= 0) return;
    const timer = window.setTimeout(onDismiss, autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [autoDismissMs, onDismiss]);

  return (
    <div
      className={`alert-inline ${toneClass} flex items-start gap-3 rounded-2xl p-4 ${className}`}
      style={{ background: config.bg, border: `1px solid ${config.border}` }}
      role="alert"
      aria-live={resolvedTone === "danger" ? "assertive" : "polite"}
    >
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color: config.iconColor }} />
      <div className="min-w-0 flex-1">
        {title ? (
          <p
            className="mb-0.5"
            style={{
              fontSize: "0.8125rem",
              fontWeight: 600,
              color: config.textColor,
            }}
          >
            {title}
          </p>
        ) : null}
        <div
          style={{
            fontSize: "0.8125rem",
            color: config.textColor,
            lineHeight: 1.5,
          }}
        >
          {children}
        </div>
      </div>
      {action ? <div className="flex-shrink-0">{action}</div> : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-white/60"
          style={{ color: config.iconColor }}
          aria-label="Fermer le message"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export function LoadingCard({ label = "Chargement…", className = "" }: { label?: string; className?: string }) {
  return (
    <Card className={className}>
      <div className="flex items-center justify-center gap-3 py-8 text-[#64748b]">
        <LoaderCircle className="h-4 w-4 animate-spin text-[#2563eb]" />
        <span style={{ fontSize: "0.8125rem" }}>{label}</span>
      </div>
    </Card>
  );
}

export function EmptyCard({
  title,
  description,
  action,
  compact = false,
  className = "",
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  if (compact) {
    return (
      <Card padding={false} className={className}>
        <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-[#f4f6fa]">
              <Inbox className="h-4.5 w-4.5 text-[#94a3b8]" />
            </div>
            <div className="min-w-0">
              <div className="text-[#374151]" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
                {title}
              </div>
              <p className="mt-1 max-w-xl text-[#94a3b8]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
                {description}
              </p>
            </div>
          </div>
          {action ? <div className="sm:flex-shrink-0">{action}</div> : null}
        </div>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <div className="flex flex-col items-center justify-center px-8 py-16 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#f4f6fa]">
          <Inbox className="h-6 w-6 text-[#94a3b8]" style={{ strokeWidth: 1.5 }} />
        </div>
        <h3 className="mb-1 text-[#374151]" style={{ fontSize: "0.9375rem", fontWeight: 600 }}>
          {title}
        </h3>
        <p className="mb-5 max-w-xs text-[#94a3b8]" style={{ fontSize: "0.8125rem", lineHeight: 1.55 }}>
          {description}
        </p>
        {action ? <div>{action}</div> : null}
      </div>
    </Card>
  );
}
