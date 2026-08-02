"use client";

import type { ReactNode } from "react";
import { AppLayout as CompareAppLayout } from "../../../../../figma-compare-srcs/components/app/AppLayout";

export function AppLayout({ children, onSearch }: { children?: ReactNode; onSearch?: () => void }) {
  return <CompareAppLayout onSearch={onSearch}>{children}</CompareAppLayout>;
}
