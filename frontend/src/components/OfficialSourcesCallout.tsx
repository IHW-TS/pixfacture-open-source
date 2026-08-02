import { OFFICIAL_SOURCES } from "@/lib/officialLinks";
import {
  sourcesLastUpdatedAvailable,
  sourcesLastUpdatedLabel,
  sourcesUpdateBannerLabel,
  showSourcesUpdateBanner,
} from "@/lib/complianceTimeline";
import styles from "./OfficialSourcesCallout.module.css";

type OfficialSourcesCalloutProps = {
  title?: string;
  compact?: boolean;
};

export default function OfficialSourcesCallout({
  title = "Source officielle",
  compact = false,
}: OfficialSourcesCalloutProps) {
  const rootClassName = compact ? styles.rootCompact : styles.root;
  const showMissingBanner = showSourcesUpdateBanner;
  const lastUpdated = sourcesLastUpdatedAvailable ? sourcesLastUpdatedLabel : "";

  return (
    <div className={`notice ${rootClassName}`}>
      {showMissingBanner && sourcesUpdateBannerLabel && (
        <div className="alert-inline warning">{sourcesUpdateBannerLabel}</div>
      )}
      <div>
        <b>{title} :</b>
      </div>
      <ul className={styles.list}>
        {OFFICIAL_SOURCES.map((source) => (
          <li key={source.url}>
            <a href={source.url} target="_blank" rel="noopener noreferrer">
              {source.label}
            </a>
          </li>
        ))}
      </ul>
      {lastUpdated && <div className={`muted ${styles.lastUpdated}`}>Dernière mise à jour : {lastUpdated}</div>}
      <div className="muted">Les sources officielles peuvent évoluer.</div>
    </div>
  );
}
