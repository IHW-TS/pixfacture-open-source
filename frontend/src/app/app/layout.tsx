import "@/figma/styles/index-next.css";
import type { ReactNode } from "react";
import AppLayoutClient from "./AppLayoutClient";

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppLayoutClient>{children}</AppLayoutClient>;
}
