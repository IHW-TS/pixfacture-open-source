"use client";

import { useMemo } from "react";
import { getComplianceCopy, getComplianceLabel } from "@/lib/complianceClaims";
import { featureFlags } from "@/lib/featureFlags";
import {
  resolveMarketingClaimLevel,
  useComplianceMarketingStatus,
  type ComplianceClaimLevel,
  type ComplianceRuntimeStatus,
} from "@/lib/einvoicingMarketing";

type ComplianceClaimInlineProps = {
  level?: ComplianceClaimLevel;
  status?: ComplianceRuntimeStatus | null;
  variant?: "label" | "quoted" | "headline" | "subline";
  className?: string;
};

export default function ComplianceClaimInline({
  level,
  status,
  variant = "label",
  className,
}: ComplianceClaimInlineProps) {
  const runtimeStatus = useComplianceMarketingStatus(status);
  const resolvedLevel = useMemo(
    () => resolveMarketingClaimLevel(level, runtimeStatus, featureFlags),
    [level, runtimeStatus],
  );
  const copy = useMemo(
    () => getComplianceCopy(resolvedLevel, runtimeStatus || undefined),
    [resolvedLevel, runtimeStatus],
  );

  let text = getComplianceLabel(resolvedLevel, runtimeStatus || undefined, { warn: true });
  if (variant === "headline") {
    text = copy.headline;
  } else if (variant === "subline") {
    text = copy.subline;
  } else if (variant === "quoted") {
    text = `“${text}”`;
  }

  return <span className={className}>{text}</span>;
}
