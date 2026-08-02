"use client";

import type { ReactNode } from "react";
import { Outlet, useLocation } from "react-router";
import { AppSidebar } from "./AppSidebar";
import { MobileBottomDock } from "./MobileBottomDock";

export function AppLayout({ children, onSearch }: { children?: ReactNode; onSearch?: () => void }) {
  const location = useLocation();
  const isEditorRoute = ["/app/invoices/new", "/app/quotes/new"].some((path) => location.pathname.startsWith(path));

  return (
    <div
      className="pf-app-shell flex h-screen overflow-hidden"
      style={{ background: "linear-gradient(180deg,#eef3f9 0%,#e7edf6 100%)" }}
    >
      <AppSidebar />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <main
          id="main-content"
          className="flex-1 overflow-y-auto overflow-x-hidden pt-14 lg:pt-0"
          style={{ background: "linear-gradient(180deg,#eef3f9 0%,#e7edf6 100%)" }}
        >
          <div className={isEditorRoute ? "" : "pb-16 lg:pb-8"}>{children ?? <Outlet />}</div>
        </main>
      </div>

      <MobileBottomDock onSearch={onSearch} />
    </div>
  );
}
