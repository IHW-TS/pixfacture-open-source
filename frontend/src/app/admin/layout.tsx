import type { ReactNode } from "react";
import ThemeApp from "./ThemeApp";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app-frame">
      <ThemeApp />
      <main id="main-content" className="page">
        {children}
      </main>
    </div>
  );
}
