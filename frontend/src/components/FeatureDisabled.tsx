"use client";

import AppPageHeader from "@/components/AppPageHeader";

type FeatureDisabledProps = {
  title?: string;
  description?: string;
  backHref?: string;
};

export default function FeatureDisabled({
  title = "Fonction desactivee",
  description = "Cette fonctionnalite est desactivee pour cet environnement.",
  backHref = "/app/settings",
}: FeatureDisabledProps) {
  return (
    <div className="app-main">
      <AppPageHeader title={title} backHref={backHref} />
      <div className="card grid-simple gap-8">
        <div>{description}</div>
        <div className="row gap-8 flex-wrap">
          <a className="btn secondary" href={backHref}>
            Retour
          </a>
        </div>
      </div>
    </div>
  );
}
