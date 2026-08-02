"use client";

import { AppSidebar as FigmaAppSidebar } from "@/figma/app/components/app/AppSidebar";

type AppSidebarProps = {
  onSearch?: () => void;
};

export function AppSidebar(_props: AppSidebarProps = {}) {
  return <FigmaAppSidebar />;
}
