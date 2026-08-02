"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchComplianceClaims, getComplianceCopy, parseComplianceClaimLevel } from "@/lib/complianceClaims";
import { usePlatformConnectionStatus } from "@/lib/usePlatformConnectionStatus";
import { PLATFORM_LABEL_LONG } from "@/lib/terminology";
import styles from "./EinvoicingDisclaimer.module.css";

type EinvoicingDisclaimerProps = {
  hasActiveConnection?: boolean | null;
  showConnectionWarning?: boolean;
  linkHref?: string;
  linkLabel?: string;
  className?: string;
};

type ComplianceClaimLevel = "export_only" | "compatible" | "partnered";
type ComplianceRuntimeStatus = {
  allowed_claims?: ComplianceClaimLevel[];
  pdp_integration_enabled?: boolean;
  seqino_enabled?: boolean;
  chorus_enabled?: boolean;
  mandate_required?: boolean;
};

const PRODUCTION_FALLBACK: ComplianceRuntimeStatus = { allowed_claims: ["export_only"] };

export default function EinvoicingDisclaimer({
  hasActiveConnection,
  showConnectionWarning = true,
  linkHref = "/app/einvoicing",
  linkLabel = "Configurer la plateforme",
  className,
}: EinvoicingDisclaimerProps) {
  const shouldFetch = showConnectionWarning && typeof hasActiveConnection !== "boolean";
  const { active } = usePlatformConnectionStatus({ enabled: shouldFetch });
  const resolvedActive = typeof hasActiveConnection === "boolean" ? hasActiveConnection : active;
  const showWarning = showConnectionWarning && resolvedActive !== true;
  const envLevel = useMemo(() => parseComplianceClaimLevel(process.env.NEXT_PUBLIC_COMPLIANCE_CLAIM_LEVEL), []);
  const [runtimeStatus, setRuntimeStatus] = useState<ComplianceRuntimeStatus | null>(
    process.env.NODE_ENV === "production" ? PRODUCTION_FALLBACK : null,
  );
  useEffect(() => {
    let activeFetch = true;
    fetchComplianceClaims().then((data) => {
      if (!activeFetch || !data) return;
      setRuntimeStatus(data);
    });
    return () => {
      activeFetch = false;
    };
  }, []);
  const complianceCopy = useMemo(
    () => getComplianceCopy(envLevel, runtimeStatus || undefined),
    [envLevel, runtimeStatus],
  );
  const rootClassName = [styles.root, className].filter(Boolean).join(" ");

  return (
    <div className={rootClassName}>
      {showWarning && (
        <div className={`alert-inline warning ${styles.warning}`}>
          <div>Activez la connexion sponsor pour transmettre, ou utilisez le mode export.</div>
          <ul className="muted mt-6 m-0 pl-18">
            {complianceCopy.disclaimers.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {linkHref && (
            <a className="btn secondary" href={linkHref}>
              {linkLabel}
            </a>
          )}
        </div>
      )}
      {!showWarning && (
        <div className="alert-inline">
          <div>{complianceCopy.subline}</div>
          <div className="muted mt-6">{complianceCopy.disclaimers.join(" ")}</div>
        </div>
      )}
    </div>
  );
}
