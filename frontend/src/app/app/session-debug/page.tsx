"use client";

import dynamic from "next/dynamic";

const SessionDebugPage = dynamic(
  () => import("@figma-compare/pages/app/MiscPages").then((mod) => mod.SessionDebugPage),
  { ssr: false },
);

export default function AppSessionDebugPage() {
  return <SessionDebugPage />;
}
