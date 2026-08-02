"use client";
import { ReactNode } from "react";
import { Footer } from "./Footer";

interface LegalLayoutProps {
  children: ReactNode;
}

export function LegalLayout({ children }: LegalLayoutProps) {
  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#f8fafc" }}>
      <main id="main-content" className="flex-1 pt-24">
        {children}
      </main>
      <Footer />
    </div>
  );
}
