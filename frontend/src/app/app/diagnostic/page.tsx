"use client";

import dynamic from "next/dynamic";

const AdminDiagnosticPage = dynamic(
  () => import("@figma-compare/pages/app/AdminPages").then((mod) => mod.AdminDiagnosticPage),
  { ssr: false },
);

export default function AppDiagnosticPage() {
  return <AdminDiagnosticPage />;
}
