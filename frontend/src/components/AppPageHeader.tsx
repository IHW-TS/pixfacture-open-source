"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

type AppPageHeaderProps = {
  title: string;
  subtitle?: string;
  backHref?: string;
  actions?: ReactNode;
  showBackButton?: boolean;
};

export default function AppPageHeader({
  title,
  subtitle,
  backHref,
  actions,
  showBackButton = true,
}: AppPageHeaderProps) {
  const router = useRouter();
  const normalizedSubtitle = subtitle?.trim() || "";
  const isBreadcrumb = Boolean(
    normalizedSubtitle &&
    (normalizedSubtitle.includes(">") || normalizedSubtitle.includes("/") || normalizedSubtitle.includes("·")),
  );

  const handleBack = () => {
    if (backHref) {
      router.push(backHref);
      return;
    }
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
      return;
    }
    router.push("/app/dashboard");
  };

  return (
    <div className="app-page-header motion-fade-in">
      {showBackButton && (
        <button type="button" className="app-page-header__back" onClick={handleBack}>
          <ArrowLeft />
          <span>Retour</span>
        </button>
      )}
      {normalizedSubtitle && isBreadcrumb && <div className="app-page-header__crumb">{normalizedSubtitle}</div>}
      <div className="app-page-header__row">
        <div className="app-page-header__left grid-simple gap-6">
          <h1 className="app-page-header__title m-0">{title}</h1>
        </div>
        {actions && <div className="app-page-header__actions row gap-8 flex-wrap">{actions}</div>}
      </div>
    </div>
  );
}
