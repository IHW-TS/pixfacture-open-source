"use client";

import { useEffect, useMemo, useState } from "react";
import { getComplianceCopy } from "@/lib/complianceClaims";
import { featureFlags } from "@/lib/featureFlags";
import {
  getMarketingClaimCoherence,
  resolveMarketingClaimLevel,
  useComplianceMarketingStatus,
  type ComplianceClaimLevel,
  type ComplianceRuntimeStatus,
} from "@/lib/einvoicingMarketing";
import { useSession } from "@/lib/useSession";

type ComplianceClaimBannerProps = {
  level?: ComplianceClaimLevel;
  status?: ComplianceRuntimeStatus | null;
  compact?: boolean;
  className?: string;
};

export default function ComplianceClaimBanner({
  level,
  status,
  compact = false,
  className,
}: ComplianceClaimBannerProps) {
  const storageKey = "compliance_claim_banner_collapsed";
  const [collapsed, setCollapsed] = useState(true);
  const [adminChecked, setAdminChecked] = useState(false);
  const { user, refresh } = useSession({ autoRefresh: false });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "false") {
      setCollapsed(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(storageKey, collapsed ? "true" : "false");
  }, [collapsed]);

  const runtimeStatus = useComplianceMarketingStatus(status);
  const coherence = useMemo(
    () => getMarketingClaimCoherence(level, runtimeStatus, featureFlags),
    [level, runtimeStatus],
  );
  const resolvedLevel = useMemo(
    () => resolveMarketingClaimLevel(level, runtimeStatus, featureFlags),
    [level, runtimeStatus],
  );
  const copy = useMemo(
    () => getComplianceCopy(resolvedLevel, runtimeStatus || undefined),
    [resolvedLevel, runtimeStatus],
  );
  const rootClassName = ["notice", className].filter(Boolean).join(" ");

  useEffect(() => {
    if (!coherence.incoherent) return;
    if (adminChecked) return;
    if (user) {
      setAdminChecked(true);
      return;
    }
    setAdminChecked(true);
    void refresh();
  }, [coherence.incoherent, adminChecked, user, refresh]);

  const showAdminWarning = coherence.incoherent && Boolean(user?.is_admin || user?.is_support);

  if (compact) {
    return (
      <div className={rootClassName} data-testid="compliance-claim-banner">
        <div className="font-700">{copy.headline}</div>
        <div className="muted">{copy.subline}</div>
        <div className="muted mt-6">{copy.disclaimers.join(" ")}</div>
        {showAdminWarning ? (
          <div className="alert-inline warning mt-8" data-testid="claim-coherence-warning">
            <div>{coherence.message}</div>
            <div className="mt-6 row gap-8 wrap">
              <a className="btn secondary" href="/app/admin/legal-pack">
                Dossier légal
              </a>
              <a className="btn secondary" href="/app/einvoicing">
                Intégrations
              </a>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={rootClassName} data-testid="compliance-claim-banner">
      <div className="font-700">{copy.headline}</div>
      <div className="muted mt-4">{copy.subline}</div>
      <div className="row gap-8 items-center mt-8">
        <button
          type="button"
          className="btn-link"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
          aria-controls="compliance-claim-details"
        >
          {collapsed ? "En savoir plus" : "Réduire"}
        </button>
      </div>
      {!collapsed && (
        <ul className="muted mt-8" id="compliance-claim-details">
          {copy.disclaimers.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      {showAdminWarning ? (
        <div className="alert-inline warning mt-8" data-testid="claim-coherence-warning">
          <div>{coherence.message}</div>
          <div className="mt-6 row gap-8 wrap">
            <a className="btn secondary" href="/app/admin/legal-pack">
              Dossier légal
            </a>
            <a className="btn secondary" href="/app/einvoicing">
              Intégrations
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
