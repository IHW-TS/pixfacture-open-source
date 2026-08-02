import type { Metadata } from "next";
import { InvitePage } from "@/figma/app/pages/auth/InvitePage";

export const metadata: Metadata = {
  title: "Accepter une invitation",
  description: "Acceptez une invitation à rejoindre un espace PixFacture.",
  robots: { index: false, follow: false },
};

export default function AppInviteAcceptPage() {
  return <InvitePage />;
}
