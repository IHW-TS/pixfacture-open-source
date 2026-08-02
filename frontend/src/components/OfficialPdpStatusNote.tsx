"use client";

import { OFFICIAL_PDP_LIST_URL } from "@/lib/officialLinks";
import { sourcesLastUpdatedAvailable, sourcesLastUpdatedLabel } from "@/lib/complianceTimeline";

type OfficialPdpStatusNoteProps = {
  className?: string;
};

export default function OfficialPdpStatusNote({ className }: OfficialPdpStatusNoteProps) {
  const classes = ["muted", "text-12", className].filter(Boolean).join(" ");
  const lastUpdated = sourcesLastUpdatedAvailable ? sourcesLastUpdatedLabel : "";

  return (
    <div className={classes}>
      Source:{" "}
      <a href={OFFICIAL_PDP_LIST_URL} target="_blank" rel="noreferrer">
        impots.gouv
      </a>
      {lastUpdated ? ` - MAJ: ${lastUpdated}` : ""}
    </div>
  );
}
