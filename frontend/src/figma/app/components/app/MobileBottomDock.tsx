"use client";

import { MobileBottomDock as CompareMobileBottomDock } from "../../../../../figma-compare-srcs/components/app/MobileBottomDock";

export function MobileBottomDock({ onSearch }: { onSearch?: () => void } = {}) {
  return <CompareMobileBottomDock onSearch={onSearch} />;
}
