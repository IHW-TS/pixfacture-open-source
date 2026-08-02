"use client";

import type { CSSProperties } from "react";
import { Copy, ExternalLink, Link2, Power, RefreshCw } from "lucide-react";
import { Card, PrimaryButton, SecondaryButton, StatusPill } from "./AppPageHeader";
import { formatDateTimeFr } from "@/lib/dateFormat";

const publicLinkActionButtonClass = "relative h-10 w-full min-w-0 justify-center px-4 text-sm font-semibold";
const publicLinkActionIconWrapClass = "pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#64748b]";
const publicLinkActionIconClass = "h-3.5 w-3.5 shrink-0";

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#e2e8f0] bg-white px-3 py-2.5">
      <div className="text-[0.6875rem] font-bold uppercase tracking-wider text-[#94a3b8]">{label}</div>
      <div className="text-sm font-bold text-[#0f172a] mt-1 tabular-nums">{value}</div>
    </div>
  );
}

export function PublicLinkCard({
  title,
  description,
  enabled,
  publicUrl,
  viewCount,
  firstViewedAt,
  lastViewedAt,
  loading = false,
  onEnable,
  onCopy,
  onOpen,
  onRotate,
  onDisable,
  primaryActionStyle,
}: {
  title: string;
  description: string;
  enabled: boolean;
  publicUrl?: string | null;
  viewCount?: number | null;
  firstViewedAt?: string | null;
  lastViewedAt?: string | null;
  loading?: boolean;
  onEnable?: () => void;
  onCopy?: () => void;
  onOpen?: () => void;
  onRotate?: () => void;
  onDisable?: () => void;
  primaryActionStyle?: CSSProperties;
}) {
  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[#0f172a] text-[0.9375rem] font-semibold mb-1">{title}</h3>
          <p className="text-sm text-[#64748b] leading-relaxed">{description}</p>
        </div>
        <StatusPill status={enabled ? "ok" : "muted"} label={enabled ? "Actif" : "Désactivé"} />
      </div>

      <div className="rounded-[18px] border border-[#e2e8f0] bg-[#f8fafc] p-3 min-h-[76px] flex items-center">
        {enabled && publicUrl ? (
          <div className="font-mono text-[0.6875rem] text-[#475569] select-all break-all w-full leading-relaxed">
            {publicUrl}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-[#94a3b8]">
            <Link2 className="w-3.5 h-3.5" /> Aucun lien public actif pour le moment.
          </div>
        )}
      </div>

      <div className="my-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MiniStat label="Vues" value={String(Number(viewCount || 0))} />
        <MiniStat label="1re vue" value={formatDateTimeFr(firstViewedAt, "—")} />
        <MiniStat label="Dernière vue" value={formatDateTimeFr(lastViewedAt, "—")} />
      </div>

      {enabled ? (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          <SecondaryButton onClick={onCopy} disabled={loading || !publicUrl} className={publicLinkActionButtonClass}>
            <span className={publicLinkActionIconWrapClass}>
              <Copy className={publicLinkActionIconClass} />
            </span>
            <span>Copier</span>
          </SecondaryButton>
          <SecondaryButton onClick={onOpen} disabled={loading || !publicUrl} className={publicLinkActionButtonClass}>
            <span className={publicLinkActionIconWrapClass}>
              <ExternalLink className={publicLinkActionIconClass} />
            </span>
            <span>Ouvrir</span>
          </SecondaryButton>
          <SecondaryButton onClick={onRotate} disabled={loading} className={publicLinkActionButtonClass}>
            <span className={publicLinkActionIconWrapClass}>
              <RefreshCw className={publicLinkActionIconClass} />
            </span>
            <span>Régénérer</span>
          </SecondaryButton>
          <SecondaryButton onClick={onDisable} disabled={loading} className={publicLinkActionButtonClass}>
            <span className={publicLinkActionIconWrapClass}>
              <Power className={publicLinkActionIconClass} />
            </span>
            <span>Désactiver</span>
          </SecondaryButton>
        </div>
      ) : (
        <PrimaryButton onClick={onEnable} disabled={loading} style={primaryActionStyle}>
          <Link2 className="w-3.5 h-3.5" /> Activer le lien public
        </PrimaryButton>
      )}
    </Card>
  );
}
