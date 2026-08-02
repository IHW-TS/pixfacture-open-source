import type { Metadata } from "next";
import { InvitePage } from "@/figma/app/pages/auth/InvitePage";

export const metadata: Metadata = {
  title: "Activer un accès invité",
  description: "Activez l'accès PixFacture qui vous a été proposé.",
  robots: { index: false, follow: false },
};

export default function AppInvitePage() {
  return <InvitePage />;
}
